import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";
import { describe, expect, it } from "vitest";
import { buildCrc20AssetVault, crc20DeploymentTag, dev1RecoveryProfile } from "@crclaunch/cove-vault";
import { quoteBuy, quoteSell } from "@crclaunch/crc20-curve";
import { dustThreshold } from "@crclaunch/cove-economics";
import { validateCrc20Trade } from "./crc20-validate.js";

bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);
const wallet = ECPairFactory(ecc).fromPrivateKey(Buffer.alloc(32, 0x42));
const walletScript = bitcoin.payments.p2wpkh({ pubkey: wallet.publicKey }).output!;
const protocolScript = Buffer.from(`0014${"33".repeat(20)}`, "hex");
const creatorScript = Buffer.from(`0014${"44".repeat(20)}`, "hex");
const guardianXOnly = Buffer.from(ecc.pointFromScalar(Buffer.alloc(32, 0x41), true)!).subarray(1);
const ownerXOnly = Buffer.from(ecc.pointFromScalar(Buffer.alloc(32, 0x43), true)!).subarray(1);
const recoveryProfile = dev1RecoveryProfile(ownerXOnly);
const deployMarkerBytes = Buffer.from('{"p":"crc-20","op":"deploy","tick":"COVE","type":"bonding","max":"2100000000000000","lim":"2100000000000000","leaf":"0","ordi":"0","btc":"1"}');
const launchSalt = Buffer.alloc(32, 0x45);
const vault = buildCrc20AssetVault({
  asset: { deploymentTag: crc20DeploymentTag(deployMarkerBytes), launchSalt },
  guardianXOnly, recoveryProfile,
});
const deployTxid = "aa".repeat(32);
const vaultTxid = "bb".repeat(32);
const walletTxid = "cc".repeat(32);
const fundingTxid = "dd".repeat(32);
const atoms = 100_000_000_000n;

function fixture(operation: "mint-buy" | "inventory-buy" | "sell", options: {
  missingSeller?: boolean;
  fundingToken?: boolean;
  badFee?: boolean;
  badReserve?: boolean;
  oldMarker?: boolean;
} = {}) {
  const sold = operation === "sell";
  const curve = {
    version: "cove-curve-v3" as const,
    mintedAtoms: operation === "mint-buy" ? 0n : atoms,
    vaultAtoms: operation === "inventory-buy" ? atoms : 0n,
    circulatingAtoms: sold ? atoms : 0n,
    vaultAnchorSats: 10_000n,
    vaultSats: sold ? 10_027n : 10_000n,
    vaultOutpoint: `${vaultTxid}:1`,
  };
  const quote = sold ? quoteSell(curve, 1_000n, dustThreshold(walletScript)) : quoteBuy(curve, 1_000n);
  const markerObject = operation === "mint-buy"
    ? { p: "crc-20", op: "mint", tick: "COVE", ...(options.oldMarker ? { amt: atoms.toString(), id: deployTxid, v: 2 } : {}) }
    : { p: "crc-20", op: "transfer", tick: "COVE", amt: atoms.toString(), ...(options.oldMarker ? { id: deployTxid, v: 2 } : {}) };
  const marker = bitcoin.script.compile([bitcoin.opcodes.OP_RETURN!, Buffer.from(JSON.stringify(markerObject))]);
  const psbt = new bitcoin.Psbt({ network: bitcoin.networks.regtest });
  psbt.addInput({ hash: vaultTxid, index: 1,
    witnessUtxo: { script: vault.scriptPubKey, value: Number(curve.vaultSats) },
    tapInternalKey: vault.numsKey, tapMerkleRoot: vault.merkleRoot,
    tapLeafScript: [{ leafVersion: 0xc0, script: vault.executionLeaf.script, controlBlock: vault.executionControlBlock }],
    sighashType: bitcoin.Transaction.SIGHASH_ALL });
  psbt.addInput({ hash: walletTxid, index: 0,
    witnessUtxo: { script: walletScript, value: sold ? 330 : 10_000 },
    sighashType: bitcoin.Transaction.SIGHASH_ALL });
  if (sold) psbt.addInput({ hash: fundingTxid, index: 0,
    witnessUtxo: { script: walletScript, value: 10_000 }, sighashType: bitcoin.Transaction.SIGHASH_ALL });
  psbt.addOutput({ script: marker, value: 0 });
  if (sold) {
    const sell = quote as ReturnType<typeof quoteSell>;
    psbt.addOutput({ script: options.badReserve ? creatorScript : vault.scriptPubKey,
      value: Number(curve.vaultSats - sell.grossSats) });
    psbt.addOutput({ script: walletScript, value: Number(sell.sellerPayoutSats + 330n) });
    psbt.addOutput({ script: protocolScript, value: Number(sell.protocolFeeSats + (options.badFee ? 1n : 0n)) });
  } else {
    const buy = quote as ReturnType<typeof quoteBuy>;
    psbt.addOutput({ script: walletScript, value: 330 });
    psbt.addOutput({ script: options.badReserve ? creatorScript : vault.scriptPubKey,
      value: Number(curve.vaultSats + buy.grossSats) });
    psbt.addOutput({ script: protocolScript, value: Number(buy.protocolFeeSats + (options.badFee ? 1n : 0n)) });
    psbt.addOutput({ script: creatorScript, value: Number(buy.creatorFeeSats) });
  }
  psbt.signInput(1, wallet);
  if (sold) psbt.signInput(2, wallet);
  const snapshot = {
    network: "regtest" as const, deployTxid, ticker: "COVE", deployMarkerBytes, launchSalt,
    creatorScript, protocolScript, vaultOutpoint: { txid: vaultTxid, vout: 1 },
    vaultScript: vault.scriptPubKey, curve, protocolVersion: 3 as const,
    sellerBalanceAtoms: sold ? atoms : 0n, cursorHeight: 100,
    cursorBlockHash: "ee".repeat(32), cursorStateRoot: "ff".repeat(32),
  };
  const prevouts = async (txid: string, vout: number) => {
    if (txid === vaultTxid && vout === 1) return { script: vault.scriptPubKey, valueSats: curve.vaultSats, confirmations: 2 };
    if (txid === walletTxid && vout === 0) return { script: walletScript, valueSats: sold ? 330n : 10_000n, confirmations: 2 };
    if (txid === fundingTxid && vout === 0) return { script: walletScript, valueSats: 10_000n, confirmations: 2 };
    return null;
  };
  const tokenPrevouts = async (txid: string, vout: number) => {
    if (txid === vaultTxid && vout === 1 && curve.vaultAtoms > 0n)
      return { deployTxid, script: vault.scriptPubKey, atoms: curve.vaultAtoms };
    if (sold && !options.missingSeller && txid === walletTxid && vout === 0)
      return { deployTxid, script: walletScript, atoms };
    if (options.fundingToken && txid === walletTxid && vout === 0)
      return { deployTxid, script: walletScript, atoms };
    return null;
  };
  return { psbt, snapshot, prevouts, tokenPrevouts, operation, guardianXOnly, recoveryProfile,
    expectedProtocolScript: protocolScript, maxMinerFeeSats: 20_000n };
}

describe("single CRC Guardian trade validation", () => {
  it("derives an amountless mint and validates inventory buy and sell", async () => {
    for (const operation of ["mint-buy", "inventory-buy", "sell"] as const) {
      await expect(validateCrc20Trade(fixture(operation))).resolves.toMatchObject({ operation, amountAtoms: atoms });
    }
  });

  it("rejects retired markers, forged backing or fees, and missing token authority", async () => {
    for (const operation of ["mint-buy", "inventory-buy", "sell"] as const) {
      await expect(validateCrc20Trade(fixture(operation, { oldMarker: true }))).rejects.toThrow(/field/i);
      await expect(validateCrc20Trade(fixture(operation, { badFee: true }))).rejects.toThrow(/fee/i);
      await expect(validateCrc20Trade(fixture(operation, { badReserve: true }))).rejects.toThrow(/reserve|backing/i);
    }
    await expect(validateCrc20Trade(fixture("sell", { missingSeller: true }))).rejects.toThrow(/token-bearing/i);
    await expect(validateCrc20Trade(fixture("mint-buy", { fundingToken: true }))).rejects.toThrow(/funding input carries token/i);
  });

  it("requires verified current prevouts and wallet signatures", async () => {
    const stale = fixture("mint-buy");
    await expect(validateCrc20Trade({ ...stale, prevouts: async () => null })).rejects.toThrow(/prevout/i);
    const unsigned = fixture("sell");
    unsigned.psbt.data.inputs[1]!.partialSig = [];
    await expect(validateCrc20Trade(unsigned)).rejects.toThrow(/signature/i);
  });
});
