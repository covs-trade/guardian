import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";
import { describe, expect, it } from "vitest";
import { buildCrc20AssetVault, crc20DeploymentTag, dev1RecoveryProfile } from "@crclaunch/cove-vault";
import { quoteBuy, quoteSell } from "@crclaunch/crc20-curve";
import { dustThreshold } from "@crclaunch/cove-economics";
import { validateCrc20Trade } from "./crc20-validate.js";

bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);
const ECPair = ECPairFactory(ecc);
const wallet = ECPair.fromPrivateKey(Buffer.alloc(32, 0x42));
const walletScript = bitcoin.payments.p2wpkh({ pubkey: wallet.publicKey }).output!;
const ordWallet = ECPair.fromPrivateKey(Buffer.alloc(32, 0x46));
const ordScript = bitcoin.payments.p2wpkh({ pubkey: ordWallet.publicKey }).output!;
const feeScript = Buffer.from(`0014${"33".repeat(20)}`, "hex");
const creatorScript = Buffer.from(`0014${"44".repeat(20)}`, "hex");
const guardianXOnly = Buffer.from(ecc.pointFromScalar(Buffer.alloc(32, 0x41), true)!).subarray(1);
const ownerXOnly = Buffer.from(ecc.pointFromScalar(Buffer.alloc(32, 0x43), true)!).subarray(1);
const recoveryProfile = dev1RecoveryProfile(ownerXOnly);
const deployMarkerBytes = Buffer.from('{"p":"crc-20","op":"deploy","tick":"COVE","type":"bonding","max":"2100000000000000","cv":"cove-curve-v1"}');
const launchSalt = Buffer.alloc(32, 0x45);
const vault = buildCrc20AssetVault({
  asset: { deploymentTag: crc20DeploymentTag(deployMarkerBytes), launchSalt },
  guardianXOnly,
  recoveryProfile,
});
const deployTxid = "aa".repeat(32);
const vaultTxid = "bb".repeat(32);
const walletTxid = "cc".repeat(32);

function fixture(kind: "mint-buy" | "sell", change?: "fee" | "vault-script" | "amount", separateWallets = false) {
  const sold = kind === "sell";
  const curve = {
    version: "cove-curve-v1" as const,
    mintedAtoms: sold ? 100_000_000_000n : 0n,
    vaultAtoms: 0n,
    circulatingAtoms: sold ? 100_000_000_000n : 0n,
    vaultAnchorSats: 10_000n,
    vaultSats: sold ? 10_027n : 10_000n,
    vaultOutpoint: `${vaultTxid}:1`,
  };
  const amountTokens = 1_000n;
  const quote = sold ? quoteSell(curve, amountTokens, dustThreshold(walletScript)) : quoteBuy(curve, amountTokens);
  const marker = bitcoin.script.compile([
    bitcoin.opcodes.OP_RETURN!,
    Buffer.from(JSON.stringify({ p: "crc-20", op: sold ? "transfer" : "mint", tick: "COVE", amt: change === "amount" ? "200000000000" : "100000000000", id: deployTxid })),
  ]);
  const psbt = new bitcoin.Psbt({ network: bitcoin.networks.regtest });
  psbt.addInput({ hash: vaultTxid, index: 1,
    witnessUtxo: { script: vault.scriptPubKey, value: Number(curve.vaultSats) },
    tapInternalKey: vault.numsKey, tapMerkleRoot: vault.merkleRoot,
    tapLeafScript: [{ leafVersion: 0xc0, script: vault.executionLeaf.script, controlBlock: vault.executionControlBlock }],
    sighashType: bitcoin.Transaction.SIGHASH_ALL,
  });
  psbt.addInput({ hash: walletTxid, index: 0,
    witnessUtxo: { script: sold && separateWallets ? ordScript : walletScript, value: 10_000 },
    sighashType: bitcoin.Transaction.SIGHASH_ALL,
  });
  if (sold && separateWallets) psbt.addInput({ hash: "ef".repeat(32), index: 0,
    witnessUtxo: { script: walletScript, value: 10_000 },
    sighashType: bitcoin.Transaction.SIGHASH_ALL,
  });
  psbt.addOutput({ script: marker, value: 0 });
  if (sold) {
    const sell = quote as ReturnType<typeof quoteSell>;
    psbt.addOutput({ script: change === "vault-script" ? creatorScript : vault.scriptPubKey, value: Number(curve.vaultSats - sell.grossSats) });
    psbt.addOutput({ script: walletScript, value: Number(sell.sellerPayoutSats) });
    psbt.addOutput({ script: feeScript, value: Number(sell.protocolFeeSats + (change === "fee" ? 1n : 0n)) });
  } else {
    const buy = quote as ReturnType<typeof quoteBuy>;
    psbt.addOutput({ script: separateWallets ? ordScript : walletScript, value: 330 });
    psbt.addOutput({ script: change === "vault-script" ? creatorScript : vault.scriptPubKey, value: Number(curve.vaultSats + buy.grossSats) });
    psbt.addOutput({ script: feeScript, value: Number(buy.protocolFeeSats + (change === "fee" ? 1n : 0n)) });
    psbt.addOutput({ script: creatorScript, value: Number(buy.creatorFeeSats) });
  }
  psbt.signInput(1, sold && separateWallets ? ordWallet : wallet);
  if (sold && separateWallets) psbt.signInput(2, wallet);
  const snapshot = {
    network: "regtest" as const,
    deployTxid, ticker: "COVE", deployMarkerBytes, launchSalt,
    creatorScript, protocolScript: feeScript,
    vaultOutpoint: { txid: vaultTxid, vout: 1 },
    vaultScript: vault.scriptPubKey,
    curve,
    sellerBalanceAtoms: sold ? 100_000_000_000n : 0n,
    cursorHeight: 100,
    cursorBlockHash: "dd".repeat(32),
    cursorStateRoot: "ee".repeat(32),
  };
  const prevouts = async (txid: string, vout: number) => {
    if (txid === vaultTxid && vout === 1) return { script: vault.scriptPubKey, valueSats: curve.vaultSats, confirmations: 2 };
    if (txid === walletTxid && vout === 0) return { script: sold && separateWallets ? ordScript : walletScript, valueSats: 10_000n, confirmations: 2 };
    if (txid === "ef".repeat(32) && vout === 0) return { script: walletScript, valueSats: 10_000n, confirmations: 2 };
    return null;
  };
  return { psbt, snapshot, prevouts };
}

describe("Guardian CRC trade validation", () => {
  it("accepts exact mint buy and sell with verified prevouts and wallet signature", async () => {
    for (const operation of ["mint-buy", "sell"] as const) {
      const f = fixture(operation);
      expect(await validateCrc20Trade({ ...f, operation, guardianXOnly, recoveryProfile, expectedProtocolScript: feeScript, maxMinerFeeSats: 20_000n })).toMatchObject({
        operation, amountAtoms: 100_000_000_000n,
      });
    }
  });

  it("rejects changed fee, vault destination, and marker amount", async () => {
    for (const change of ["fee", "vault-script", "amount"] as const) {
      const f = fixture("mint-buy", change);
      await expect(validateCrc20Trade({ ...f, operation: "mint-buy", guardianXOnly, recoveryProfile, expectedProtocolScript: feeScript, maxMinerFeeSats: 20_000n })).rejects.toThrow();
    }
  });

  it("rejects forged Core prevout and missing wallet signature", async () => {
    const f = fixture("mint-buy");
    await expect(validateCrc20Trade({ ...f, prevouts: async () => null, operation: "mint-buy", guardianXOnly, recoveryProfile, expectedProtocolScript: feeScript, maxMinerFeeSats: 20_000n })).rejects.toThrow(/prevout/i);
    f.psbt.data.inputs[1]!.partialSig = [];
    await expect(validateCrc20Trade({ ...f, operation: "mint-buy", guardianXOnly, recoveryProfile, expectedProtocolScript: feeScript, maxMinerFeeSats: 20_000n })).rejects.toThrow(/signature/i);
  });

  it("rejects a seller with insufficient token balance", async () => {
    const f = fixture("sell");
    await expect(validateCrc20Trade({ ...f, snapshot: { ...f.snapshot, sellerBalanceAtoms: 0n }, operation: "sell", guardianXOnly, recoveryProfile, expectedProtocolScript: feeScript, maxMinerFeeSats: 20_000n })).rejects.toThrow(/balance/i);
  });
  it("accepts separate ordinals token authority and payments fee/payout wallet", async () => {
    const f = fixture("sell", undefined, true);
    await expect(validateCrc20Trade({ ...f, operation: "sell", guardianXOnly, recoveryProfile,
      expectedProtocolScript: feeScript, maxMinerFeeSats: 20_000n })).resolves.toMatchObject({ operation: "sell" });
    const b = fixture("mint-buy", undefined, true);
    await expect(validateCrc20Trade({ ...b, operation: "mint-buy", guardianXOnly, recoveryProfile,
      expectedProtocolScript: feeScript, maxMinerFeeSats: 20_000n })).resolves.toMatchObject({ operation: "mint-buy" });
  });
  it("accepts a signed nested SegWit funding input and rejects an unrelated redeem script", async () => {
    const f = fixture("mint-buy");
    const redeem = bitcoin.payments.p2wpkh({ pubkey: wallet.publicKey }).output!;
    const nested = bitcoin.payments.p2sh({ redeem: { output: redeem } }).output!;
    delete f.psbt.data.inputs[1]!.partialSig;
    f.psbt.data.inputs[1]!.witnessUtxo!.script = nested;
    f.psbt.updateInput(1, { redeemScript: redeem });
    f.psbt.signInput(1, wallet);
    const prevouts = async (txid: string, vout: number) =>
      txid === walletTxid && vout === 0
        ? { script: nested, valueSats: 10_000n, confirmations: 2 }
        : f.prevouts(txid, vout);
    await expect(validateCrc20Trade({ ...f, prevouts, operation: "mint-buy", guardianXOnly,
      recoveryProfile, expectedProtocolScript: feeScript, maxMinerFeeSats: 20_000n })).resolves.toMatchObject({ operation: "mint-buy" });
    f.psbt.data.inputs[1]!.redeemScript = Buffer.from(`0014${"77".repeat(20)}`, "hex");
    await expect(validateCrc20Trade({ ...f, prevouts, operation: "mint-buy", guardianXOnly,
      recoveryProfile, expectedProtocolScript: feeScript, maxMinerFeeSats: 20_000n })).rejects.toThrow(/signature|redeem/i);
  });

  it("reconstructs canonical vault leaf metadata without changing the wallet-signed transaction", async () => {
    const f = fixture("mint-buy");
    const txBefore = f.psbt.data.globalMap.unsignedTx.toBuffer().toString("hex");
    delete f.psbt.data.inputs[0]!.tapInternalKey;
    delete f.psbt.data.inputs[0]!.tapMerkleRoot;
    delete f.psbt.data.inputs[0]!.tapLeafScript;
    await validateCrc20Trade({ ...f, operation: "mint-buy", guardianXOnly, recoveryProfile, expectedProtocolScript: feeScript, maxMinerFeeSats: 20_000n });
    const restored = bitcoin.Psbt.fromBase64(f.psbt.toBase64());
    expect(restored.data.inputs[0]!.tapLeafScript?.[0]?.script.equals(vault.executionLeaf.script)).toBe(true);
    expect(f.psbt.data.globalMap.unsignedTx.toBuffer().toString("hex")).toBe(txBefore);
  });
});
