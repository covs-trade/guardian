import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";
import { describe, expect, it } from "vitest";
import { buildCrc20BackingVault, dev1RecoveryProfile } from "@crclaunch/cove-vault";
import { TestGuardianCustodyBackend } from "./v3/custody.js";
import { verifyVaultExecutionSignature } from "./v3/signer.js";
import { signCrc20VaultInput } from "./crc20.js";

bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);
const ECPair = ECPairFactory(ecc);
const guardianPriv = Buffer.alloc(32, 0x41);
const wallet = ECPair.fromPrivateKey(Buffer.alloc(32, 0x42));
const guardianXOnly = Buffer.from(ecc.pointFromScalar(guardianPriv, true)!).subarray(1);
const ownerXOnly = Buffer.from(ecc.pointFromScalar(Buffer.alloc(32, 0x43), true)!).subarray(1);
const vault = buildCrc20BackingVault({
  state: {
    deploymentTag: Buffer.alloc(32, 0x44),
    launchSalt: Buffer.alloc(32, 0x45),
    mintedAtoms: 0n,
    vaultAtoms: 0n,
    backingSats: 0n,
    anchorSats: 10_000n,
  },
  guardianXOnly,
  recoveryProfile: dev1RecoveryProfile(ownerXOnly),
});
const backend = new TestGuardianCustodyBackend(guardianPriv);

function transaction(): bitcoin.Psbt {
  const psbt = new bitcoin.Psbt({ network: bitcoin.networks.regtest });
  psbt.addInput({
    hash: "11".repeat(32), index: 1,
    witnessUtxo: { script: vault.scriptPubKey, value: 10_000 },
    tapInternalKey: vault.numsKey,
    tapMerkleRoot: vault.merkleRoot,
    tapLeafScript: [{ leafVersion: 0xc0, script: vault.executionLeaf.script, controlBlock: vault.executionControlBlock }],
    sighashType: bitcoin.Transaction.SIGHASH_ALL,
  });
  psbt.addInput({
    hash: "22".repeat(32), index: 0,
    witnessUtxo: { script: bitcoin.payments.p2wpkh({ pubkey: wallet.publicKey }).output!, value: 20_000 },
    sighashType: bitcoin.Transaction.SIGHASH_ALL,
  });
  psbt.addOutput({ script: vault.scriptPubKey, value: 28_000 });
  return psbt;
}

describe("CRC vault Guardian signature", () => {
  it("refuses to sign when the trader input has no valid ALL signature", async () => {
    await expect(signCrc20VaultInput(transaction(), vault, backend)).rejects.toThrow(/wallet signature/i);
  });

  it("signs the exact transaction after the trader and commits SIGHASH_ALL", async () => {
    const psbt = transaction();
    psbt.signInput(1, wallet);
    const sig = await signCrc20VaultInput(psbt, vault, backend);
    expect(sig).toHaveLength(65);
    expect(sig[64]).toBe(bitcoin.Transaction.SIGHASH_ALL);
    expect(psbt.data.inputs[0]!.finalScriptWitness).toBeDefined();
    expect(() => verifyVaultExecutionSignature(psbt, 0, vault.executionLeaf, sig, guardianXOnly)).not.toThrow();
    const changed = transaction();
    changed.addOutput({ script: Buffer.from(`0014${"55".repeat(20)}`, "hex"), value: 330 });
    expect(() => verifyVaultExecutionSignature(changed, 0, vault.executionLeaf, sig, guardianXOnly)).toThrow(/verify/i);
  });

  it("refuses a mismatched vault script even with a wallet signature", async () => {
    const psbt = transaction();
    psbt.signInput(1, wallet);
    psbt.data.inputs[0]!.witnessUtxo!.script = Buffer.from(`5120${"66".repeat(32)}`, "hex");
    await expect(signCrc20VaultInput(psbt, vault, backend)).rejects.toThrow(/vault script/i);
  });
});
