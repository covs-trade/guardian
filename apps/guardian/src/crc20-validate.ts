import * as bitcoin from "bitcoinjs-lib";
import { checkSpendSignature, spendKindOf, scriptForKind } from "@crclaunch/bitcoin";
import { dustThreshold } from "@crclaunch/cove-economics";
import { quoteBuy, quoteSell, type CurveState } from "@crclaunch/crc20-curve";
import { buildCrc20AssetVault, crc20DeploymentTag, type VaultRecoveryProfile } from "@crclaunch/cove-vault";
import { preflightCoveCrcPsbt, type CrcTradeOperation } from "./crc20-preflight.js";

export interface CrcTrustedSnapshot {
  network: "regtest" | "signet" | "testnet" | "mainnet";
  deployTxid: string;
  ticker: string;
  deployMarkerBytes: Buffer;
  launchSalt: Buffer;
  creatorScript: Buffer;
  protocolScript: Buffer;
  vaultOutpoint: { txid: string; vout: number };
  vaultScript: Buffer;
  curve: CurveState;
  protocolVersion?: 1 | 2;
  sellerBalanceAtoms: bigint;
  cursorHeight: number;
  cursorBlockHash: string;
  cursorStateRoot: string;
}

export interface VerifiedCrcPrevout {
  script: Buffer;
  valueSats: bigint;
  confirmations: number;
}

export interface VerifiedCrcTokenPrevout {
  deployTxid: string;
  script: Buffer;
  atoms: bigint;
}

export interface ValidateCrcTradeParams {
  psbt: bitcoin.Psbt;
  operation: CrcTradeOperation;
  snapshot: CrcTrustedSnapshot;
  guardianXOnly: Buffer;
  recoveryProfile: VaultRecoveryProfile;
  expectedProtocolScript: Buffer;
  prevouts: (txid: string, vout: number) => Promise<VerifiedCrcPrevout | null>;
  tokenPrevouts?: (txid: string, vout: number) => Promise<VerifiedCrcTokenPrevout | null>;
  maxMinerFeeSats: bigint;
  assertCurrent?: () => Promise<void>;
}

export interface ValidatedCrcTrade {
  operation: CrcTradeOperation;
  amountAtoms: bigint;
  grossSats: bigint;
  protocolFeeSats: bigint;
  minerFeeSats: bigint;
  nextVaultVout: 1 | 2;
}

function exact(out: bitcoin.Transaction["outs"][number] | undefined, script: Buffer, sats: bigint): boolean {
  return !!out && out.script.equals(script) && BigInt(out.value) === sats;
}

function bitcoinNetwork(network: CrcTrustedSnapshot["network"]): bitcoin.networks.Network {
  return network === "mainnet" ? bitcoin.networks.bitcoin :
    network === "regtest" ? bitcoin.networks.regtest : bitcoin.networks.testnet;
}

export async function validateCrc20Trade(params: ValidateCrcTradeParams): Promise<ValidatedCrcTrade> {
  const { psbt, snapshot, operation } = params;
  if (!/^[0-9a-f]{64}$/.test(snapshot.deployTxid) ||
    !/^[0-9a-f]{64}$/.test(snapshot.cursorBlockHash) ||
    !/^[0-9a-f]{64}$/.test(snapshot.cursorStateRoot) ||
    !Number.isSafeInteger(snapshot.cursorHeight) || snapshot.cursorHeight < 0)
    throw new Error("invalid trusted CRC snapshot");
  if (snapshot.curve.vaultOutpoint !== `${snapshot.vaultOutpoint.txid}:${snapshot.vaultOutpoint.vout}` ||
    snapshot.curve.vaultSats <= 0n ||
    snapshot.curve.version !== `cove-curve-v${snapshot.protocolVersion ?? 1}`)
    throw new Error("CRC vault state and outpoint mismatch");
  const vault = buildCrc20AssetVault({
    asset: { deploymentTag: crc20DeploymentTag(snapshot.deployMarkerBytes), launchSalt: snapshot.launchSalt },
    guardianXOnly: params.guardianXOnly,
    recoveryProfile: params.recoveryProfile,
    network: bitcoinNetwork(snapshot.network),
  });
  if (!vault.scriptPubKey.equals(snapshot.vaultScript))
    throw new Error("CRC trusted vault script does not match registered identity");
  if (!snapshot.protocolScript.equals(params.expectedProtocolScript))
    throw new Error("CRC protocol fee destination differs from configured network script");
  const preflight = preflightCoveCrcPsbt(psbt, {
    operation,
    deploymentTxid: snapshot.deployTxid,
    ticker: snapshot.ticker,
    vaultOutpoint: snapshot.vaultOutpoint,
    version: snapshot.protocolVersion ?? 1,
  });
  const first = psbt.data.inputs[0]!;
  if (!first.witnessUtxo?.script.equals(vault.scriptPubKey) ||
    BigInt(first.witnessUtxo.value) !== snapshot.curve.vaultSats ||
    (first.tapInternalKey && !first.tapInternalKey.equals(vault.numsKey)) ||
    (first.tapMerkleRoot && !first.tapMerkleRoot.equals(vault.merkleRoot)) ||
    (first.tapLeafScript && (first.tapLeafScript.length !== 1 ||
      !first.tapLeafScript[0]!.script.equals(vault.executionLeaf.script) ||
      !first.tapLeafScript[0]!.controlBlock.equals(vault.executionControlBlock))))
    throw new Error("CRC vault PSBT commitment mismatch");

  const v2 = (snapshot.protocolVersion ?? 1) === 2;
  if (v2 && !params.tokenPrevouts) throw new Error("CRC v2 token outpoint lookup is unavailable");
  const tokenRows = v2 ? await Promise.all(psbt.txInputs.map((input) =>
    params.tokenPrevouts!(Buffer.from(input.hash).reverse().toString("hex"), input.index))) : [];
  const authorityScript = psbt.data.inputs[1]!.witnessUtxo!.script;
  let sellerTokenCount = 0;
  let sellerCarrierSats = 0n;
  if (v2) {
    const vaultRow = tokenRows[0];
    if (vaultRow && (vaultRow.deployTxid !== snapshot.deployTxid ||
      !vaultRow.script.equals(vault.scriptPubKey) || vaultRow.atoms !== snapshot.curve.vaultAtoms))
      throw new Error("CRC v2 vault token outpoint mismatch");
    if (snapshot.curve.vaultAtoms > 0n && !vaultRow)
      throw new Error("CRC v2 vault token outpoint is missing");
    if (operation === "inventory-buy" && !vaultRow || operation === "mint-buy" && vaultRow)
      throw new Error("CRC v2 vault inventory authority mismatch");
    if (operation === "sell") {
      for (let index = 1; index < tokenRows.length; index++) {
        const row = tokenRows[index];
        if (!row) break;
        if (row.deployTxid !== snapshot.deployTxid || !row.script.equals(authorityScript) || row.atoms <= 0n)
          throw new Error("CRC seller token input has wrong asset or owner");
        sellerTokenCount++;
      }
      if (sellerTokenCount === 0) throw new Error("CRC sell requires token-bearing seller input");
      sellerCarrierSats = psbt.data.inputs.slice(1, 1 + sellerTokenCount)
        .reduce((sum, input) => sum + BigInt(input.witnessUtxo!.value), 0n);
      const selected = tokenRows.slice(1, 1 + sellerTokenCount).reduce((sum, row) => sum + row!.atoms, 0n);
      if (selected < preflight.amountAtoms) throw new Error("CRC seller token outpoints are insufficient");
      const remainder = selected - preflight.amountAtoms;
      if (remainder > 0n && preflight.changeVout !== 4 || remainder === 0n && preflight.changeVout !== undefined)
        throw new Error("CRC seller token change marker mismatch");
      if (remainder > 0n && !psbt.txOutputs[4]?.script.equals(authorityScript))
        throw new Error("CRC seller token change output has wrong owner");
    }
    for (let index = operation === "sell" ? 1 + sellerTokenCount : 1; index < tokenRows.length; index++) {
      if (tokenRows[index]) throw new Error("CRC funding input carries token authority");
    }
  }
  const payerIndex = operation === "sell" ? 1 + Math.max(sellerTokenCount, 1) : 1;
  const paymentScript = operation === "sell" && psbt.data.inputs[payerIndex]?.witnessUtxo
    ? psbt.data.inputs[payerIndex]!.witnessUtxo!.script : authorityScript;
  const payoutScript = v2 && operation === "sell" ? authorityScript : paymentScript;
  let inputSats = 0n;
  for (let index = 0; index < psbt.txInputs.length; index++) {
    const input = psbt.txInputs[index]!;
    const txid = Buffer.from(input.hash).reverse().toString("hex");
    const verified = await params.prevouts(txid, input.index);
    const claimed = psbt.data.inputs[index]!.witnessUtxo!;
    if (!verified || verified.confirmations < 1 ||
      !verified.script.equals(claimed.script) || verified.valueSats !== BigInt(claimed.value))
      throw new Error(`CRC input ${index} prevout is spent, unconfirmed, or mismatched`);
    if (index > 0) {
      const expectedFundingScript = operation === "sell" && index > Math.max(sellerTokenCount, 1) ? paymentScript : authorityScript;
      if (!claimed.script.equals(expectedFundingScript))
        throw new Error("CRC trade funding input has an unexpected owner script");
      const kind = spendKindOf(claimed.script);
      if (!kind) throw new Error("CRC wallet input has unsupported script type");
      if (kind !== "p2tr") {
        const pubkey = psbt.data.inputs[index]!.partialSig?.[0]?.pubkey;
        if (!pubkey || psbt.data.inputs[index]!.partialSig?.length !== 1 ||
          !scriptForKind(kind, pubkey, bitcoinNetwork(snapshot.network)).equals(claimed.script))
          throw new Error("CRC wallet signature key does not own its input script");
      }
      const signature = checkSpendSignature(psbt, index);
      if (!signature.ok) throw new Error(`CRC wallet signature invalid: ${signature.detail}`);
    }
    inputSats += verified.valueSats;
  }
  const outputs = psbt.txOutputs;
  let outputSats = 0n;
  for (let index = 0; index < outputs.length; index++) {
    const output = outputs[index]!;
    if (index > 0 && BigInt(output.value) < dustThreshold(output.script))
      throw new Error(`CRC output ${index} is dust`);
    outputSats += BigInt(output.value);
  }
  const minerFeeSats = inputSats - outputSats;
  if (minerFeeSats < 0n || minerFeeSats > params.maxMinerFeeSats)
    throw new Error("CRC miner fee is outside policy cap");
  const amountTokens = preflight.amountAtoms / 100_000_000n;
  let grossSats: bigint;
  let protocolFeeSats: bigint;
  if (operation === "sell") {
    if (!v2 && snapshot.sellerBalanceAtoms < preflight.amountAtoms)
      throw new Error("CRC seller token balance is insufficient");
    if (!spendKindOf(payoutScript)) throw new Error("CRC payout script is unsupported");
    const payoutDust = dustThreshold(payoutScript);
    const quote = quoteSell(snapshot.curve, amountTokens, payoutDust);
    if (!exact(outputs[1], vault.scriptPubKey, snapshot.curve.vaultSats - quote.grossSats) ||
      !exact(outputs[2], payoutScript, quote.sellerPayoutSats + sellerCarrierSats) ||
      !exact(outputs[3], snapshot.protocolScript, quote.protocolFeeSats))
      throw new Error("CRC sell backing, payout, or fee mismatch");
    grossSats = quote.grossSats;
    protocolFeeSats = quote.protocolFeeSats;
  } else {
    const quote = quoteBuy(snapshot.curve, amountTokens);
    const required = operation === "mint-buy" ? "mint" : "transfer";
    if (quote.operation !== required ||
      preflight.recipientScript.equals(vault.scriptPubKey) ||
      !spendKindOf(preflight.recipientScript) ||
      !exact(outputs[2], vault.scriptPubKey, snapshot.curve.vaultSats + quote.grossSats) ||
      !exact(outputs[3], snapshot.protocolScript, quote.protocolFeeSats) ||
      !exact(outputs[4], snapshot.creatorScript, quote.creatorFeeSats))
      throw new Error("CRC buy reserve, inventory, or fee mismatch");
    grossSats = quote.grossSats;
    protocolFeeSats = quote.protocolFeeSats;
  }
  const changeVout = operation === "sell" ? (preflight.changeVout === 4 ? 5 : 4) : 5;
  if (outputs[changeVout] && !outputs[changeVout]!.script.equals(paymentScript))
    throw new Error("CRC change output is not owned by payer");
  await params.assertCurrent?.();
  psbt.updateInput(0, {
    ...(!first.tapInternalKey ? { tapInternalKey: vault.numsKey } : {}),
    ...(!first.tapMerkleRoot ? { tapMerkleRoot: vault.merkleRoot } : {}),
    ...(!first.tapLeafScript ? { tapLeafScript: [{
      leafVersion: 0xc0,
      script: vault.executionLeaf.script,
      controlBlock: vault.executionControlBlock,
    }] } : {}),
  });
  return { operation, amountAtoms: preflight.amountAtoms, grossSats, protocolFeeSats, minerFeeSats,
    nextVaultVout: operation === "sell" ? 1 : 2 };
}
