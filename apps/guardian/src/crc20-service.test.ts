import { createHash } from "node:crypto";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";
import { describe, expect, it, vi } from "vitest";
import { buildCrc20AssetVault, crc20DeploymentTag, dev1RecoveryProfile } from "@crclaunch/cove-vault";
import { TestGuardianCustodyBackend } from "@crclaunch/cove-guardian/v3";
import { CrcGuardianSigningService } from "./crc20-service.js";

const loadSnapshot = vi.hoisted(() => vi.fn());
vi.mock("./crc20-view.js", () => ({ loadCrcTrustedSnapshot: loadSnapshot }));
bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);
const ECPair = ECPairFactory(ecc);

function setup() {
  const guardianPriv = Buffer.alloc(32, 0x41);
  const wallet = ECPair.fromPrivateKey(Buffer.alloc(32, 0x42));
  const walletScript = bitcoin.payments.p2wpkh({ pubkey: wallet.publicKey }).output!;
  const guardianXOnly = Buffer.from(ecc.pointFromScalar(guardianPriv, true)!).subarray(1);
  const recoveryProfile = dev1RecoveryProfile(Buffer.from(ecc.pointFromScalar(Buffer.alloc(32, 0x43), true)!).subarray(1));
  const deployMarkerBytes = Buffer.from('{"p":"crc-20","op":"deploy","tick":"COVE","type":"bonding","max":"2100000000000000","cv":"cove-curve-v3"}');
  const launchSalt = Buffer.alloc(32, 0x45);
  const vault = buildCrc20AssetVault({ asset: { deploymentTag: crc20DeploymentTag(deployMarkerBytes), launchSalt }, guardianXOnly, recoveryProfile });
  const feeScript = Buffer.from(`0014${"33".repeat(20)}`, "hex");
  const creatorScript = Buffer.from(`0014${"44".repeat(20)}`, "hex");
  const deployTxid = "aa".repeat(32);
  const vaultTxid = "bb".repeat(32);
  const walletTxid = "cc".repeat(32);
  const psbt = new bitcoin.Psbt({ network: bitcoin.networks.regtest });
  psbt.addInput({ hash: vaultTxid, index: 1,
    witnessUtxo: { script: vault.scriptPubKey, value: 10_000 },
    sighashType: bitcoin.Transaction.SIGHASH_ALL,
  });
  psbt.addInput({ hash: walletTxid, index: 0,
    witnessUtxo: { script: walletScript, value: 10_000 },
    sighashType: bitcoin.Transaction.SIGHASH_ALL,
  });
  psbt.addOutput({ script: bitcoin.script.compile([bitcoin.opcodes.OP_RETURN!, Buffer.from(JSON.stringify({
    p: "crc-20", op: "mint", tick: "COVE",
  }))]), value: 0 });
  psbt.addOutput({ script: walletScript, value: 330 });
  psbt.addOutput({ script: vault.scriptPubKey, value: 10_027 });
  psbt.addOutput({ script: feeScript, value: 5_013 });
  psbt.addOutput({ script: creatorScript, value: 546 });
  psbt.signInput(1, wallet);
  const snapshot = {
    network: "regtest" as const, deployTxid, ticker: "COVE", deployMarkerBytes, launchSalt,
    creatorScript, protocolScript: feeScript, vaultOutpoint: { txid: vaultTxid, vout: 1 },
    vaultScript: vault.scriptPubKey,
    curve: { version: "cove-curve-v3" as const, mintedAtoms: 0n, vaultAtoms: 0n,
      circulatingAtoms: 0n, vaultAnchorSats: 10_000n, vaultSats: 10_000n,
      vaultOutpoint: `${vaultTxid}:1` },
    sellerBalanceAtoms: 0n, protocolVersion: 3 as const,
    cursorHeight: 100, cursorBlockHash: "dd".repeat(32), cursorStateRoot: "ee".repeat(32),
  };
  loadSnapshot.mockResolvedValue(snapshot);
  const stateRow = { protocol_version: 3, txid: vaultTxid, vout: 1, script_hex: vault.scriptPubKey.toString("hex"),
    btc_sats: "10000", minted_atoms: "0", inventory_atoms: "0", availability: "active",
    cursor_height: "100", cursor_hash: snapshot.cursorBlockHash, state_root: snapshot.cursorStateRoot,
    seller_balance_atoms: "0" };
  let statements = 0;
  const db = { execute: vi.fn(async () => {
    statements++;
    if (statements === 2 || statements === 3) return { rows: [] };
    if (statements === 5 || statements === 7) return { rows: [{ unsigned_tx_digest: "ok" }] };
    return { rows: [stateRow] };
  }) };
  const core = {
    getBlockHash: vi.fn(async () => snapshot.cursorBlockHash),
    getTxout: vi.fn(async (txid: string, vout: number) => {
      if (txid === vaultTxid && vout === 1) return { scriptPubKeyHex: vault.scriptPubKey.toString("hex"), valueSats: 10_000n, confirmations: 2 };
      if (txid === walletTxid && vout === 0) return { scriptPubKeyHex: walletScript.toString("hex"), valueSats: 10_000n, confirmations: 2 };
      return null;
    }),
  };
  const backend = new TestGuardianCustodyBackend(guardianPriv);
  const sign = vi.spyOn(backend, "signTaprootScriptPath").mockImplementation(async (params) => {
    expect(statements).toBe(6);
    return Buffer.from(ecc.signSchnorr(params.sighash, guardianPriv));
  });
  const service = new CrcGuardianSigningService({
    db: db as never, core: core as never, custodyBackend: backend,
    guardianXOnly, recoveryProfile, network: "regtest", protocolScript: feeScript, maxMinerFeeSats: 20_000n,
  });
  return { service, psbt, db, core, sign, deployTxid };
}

describe("CRC Guardian signing coordinator", () => {
  it("refuses peer market fills because they have no Guardian vault signature", async () => {
    const f = setup();
    const result = await f.service.sign({ requestId: "market", network: "regtest", deploymentTxid: f.deployTxid,
      operation: "market-fill", psbtBase64: f.psbt.toBase64() });
    expect(result).toMatchObject({ ok: false, reason: "CRC_SIGN_REJECTED" });
    expect(f.sign).not.toHaveBeenCalled();
    expect(f.db.execute).not.toHaveBeenCalled();
  });
  it("validates trusted state and Core, journals before signing, and persists signed PSBT", async () => {
    const f = setup();
    const result = await f.service.sign({ requestId: "r1", network: "regtest", deploymentTxid: f.deployTxid,
      operation: "mint-buy", psbtBase64: f.psbt.toBase64() });
    expect(result).toMatchObject({ ok: true });
    expect(f.sign).toHaveBeenCalledTimes(1);
    expect(f.db.execute).toHaveBeenCalledTimes(7);
    expect(f.core.getTxout).toHaveBeenCalledTimes(2);
    if (result.ok) {
      expect(result.unsignedTxDigest).toBe(createHash("sha256")
        .update(f.psbt.data.globalMap.unsignedTx.toBuffer()).digest("hex"));
      expect(bitcoin.Psbt.fromBase64(result.signedPsbtBase64).data.inputs[0]?.finalScriptWitness).toBeDefined();
      expect(result.signatureHex).toHaveLength(130);
    }
  });
  it("never reaches custody when Core disagrees with the indexed cursor", async () => {
    const f = setup();
    f.core.getBlockHash.mockResolvedValue("ff".repeat(32));
    const result = await f.service.sign({ requestId: "r2", network: "regtest", deploymentTxid: f.deployTxid,
      operation: "mint-buy", psbtBase64: f.psbt.toBase64() });
    expect(result).toMatchObject({ ok: false, reason: "CRC_SIGN_REJECTED" });
    expect(f.sign).not.toHaveBeenCalled();
    expect(f.db.execute).not.toHaveBeenCalled();
  });
  it("never reaches custody when the pre-sign journal cannot persist", async () => {
    const f = setup();
    const original = f.db.execute.getMockImplementation()!;
    let calls = 0;
    f.db.execute.mockImplementation(async () => {
      calls++;
      if (calls === 5) throw new Error("journal unavailable");
      return original();
    });
    const result = await f.service.sign({ requestId: "r3", network: "regtest", deploymentTxid: f.deployTxid,
      operation: "mint-buy", psbtBase64: f.psbt.toBase64() });
    expect(result).toMatchObject({ ok: false, reason: "CRC_SIGN_REJECTED" });
    expect(f.sign).not.toHaveBeenCalled();
    expect(calls).toBe(5);
  });
});
