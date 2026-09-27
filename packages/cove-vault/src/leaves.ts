import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
const OP_EQUALVERIFY = 0x88;
const OP_CHECKSIG = 0xac;
const OP_CHECKSEQUENCEVERIFY = 0xb2;
const OP_2DROP = 0x6d;
export const RECOVERY_CSV_BLOCKS = 144;
export function buildExecutionLeaf(
  policyIdentityHash: Buffer,
  guardianXOnly: Buffer,
): Buffer {
  if (policyIdentityHash.length !== 32) {
    throw new Error(
      `policyIdentityHash must be 32 bytes, got ${policyIdentityHash.length}`,
    );
  }
  if (guardianXOnly.length !== 32) {
    throw new Error(
      `guardianXOnly must be 32 bytes, got ${guardianXOnly.length}`,
    );
  }
  if (!ecc.isXOnlyPoint(guardianXOnly)) {
    throw new Error("guardianXOnly is not on the secp256k1 curve");
  }
  return bitcoin.script.compile([
    policyIdentityHash,
    OP_EQUALVERIFY,
    guardianXOnly,
    OP_CHECKSIG,
  ]) as Buffer;
}
export function buildRecoveryLeaf(ownerXOnly: Buffer): Buffer {
  if (ownerXOnly.length !== 32) {
    throw new Error(`ownerXOnly must be 32 bytes, got ${ownerXOnly.length}`);
  }
  return bitcoin.script.compile([
    bitcoin.script.number.encode(RECOVERY_CSV_BLOCKS),
    OP_CHECKSEQUENCEVERIFY,
    OP_2DROP,
    ownerXOnly,
    OP_CHECKSIG,
  ]) as Buffer;
}
