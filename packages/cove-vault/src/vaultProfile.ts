import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
export type VaultProfileVersion =
  "COVE_V3_VAULT_PROFILE_DEV1" | "COVE_V3_VAULT_PROFILE_MAINNET1";
export interface VaultRecoveryProfile {
  profileVersion: VaultProfileVersion;
  recoveryCsvBlocks: number;
  recoveryThreshold: number;
  recoveryPubkeys: Buffer[];
}
const OP_DROP = 0x75;
const OP_CHECKSEQUENCEVERIFY = 0xb2;
const OP_CHECKSIG = 0xac;
const OP_CHECKSIGADD = 0xba;
const OP_NUMEQUAL = 0x9c;
export function sortRecoveryPubkeys(pubkeys: Buffer[]): Buffer[] {
  const seen = new Set<string>();
  for (const k of pubkeys) {
    if (k.length !== 32)
      throw new Error("recovery pubkeys must be 32-byte x-only keys");
    if (!ecc.isXOnlyPoint(k))
      throw new Error("recovery pubkey is not on the secp256k1 curve");
    const hex = k.toString("hex");
    if (seen.has(hex)) throw new Error(`duplicate recovery pubkey ${hex}`);
    seen.add(hex);
  }
  return [...pubkeys].sort((a, b) => Buffer.compare(a, b));
}
export function buildThresholdRecoveryLeaf(
  csvBlocks: number,
  threshold: number,
  pubkeys: Buffer[],
): Buffer {
  if (!Number.isInteger(csvBlocks) || csvBlocks <= 0)
    throw new Error("csvBlocks must be positive");
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > 16)
    throw new Error("threshold must be 1..16");
  if (threshold > pubkeys.length)
    throw new Error("threshold exceeds pubkey count");
  const keys = sortRecoveryPubkeys(pubkeys);
  const ops: (number | Buffer)[] = [
    bitcoin.script.number.encode(csvBlocks),
    OP_CHECKSEQUENCEVERIFY,
    OP_DROP,
  ];
  for (let i = 0; i < keys.length; i++) {
    ops.push(keys[i]!);
    ops.push(i === 0 ? OP_CHECKSIG : OP_CHECKSIGADD);
  }
  ops.push(0x50 + threshold);
  ops.push(OP_NUMEQUAL);
  return bitcoin.script.compile(ops) as Buffer;
}
export function buildThresholdRecoveryWitness(params: {
  pubkeys: Buffer[];
  signatures: Map<string, Buffer>;
  threshold: number;
}): Buffer[] {
  const keys = sortRecoveryPubkeys(params.pubkeys);
  const present = keys.filter((k) => params.signatures.has(k.toString("hex")));
  if (present.length < params.threshold) {
    throw new Error(
      `recovery threshold not met: ${present.length}/${params.threshold} signatures`,
    );
  }
  const used = new Set(
    present.slice(0, params.threshold).map((k) => k.toString("hex")),
  );
  const stack: Buffer[] = [];
  for (let i = keys.length - 1; i >= 0; i--) {
    const sig = used.has(keys[i]!.toString("hex"))
      ? params.signatures.get(keys[i]!.toString("hex"))
      : undefined;
    stack.push(sig ? Buffer.from(sig) : Buffer.alloc(0));
  }
  return stack;
}
export function buildDev1RecoveryLeaf(ownerXOnly: Buffer): Buffer {
  if (ownerXOnly.length !== 32) throw new Error("ownerXOnly must be 32 bytes");
  return bitcoin.script.compile([
    bitcoin.script.number.encode(144),
    OP_CHECKSEQUENCEVERIFY,
    0x6d,
    ownerXOnly,
    OP_CHECKSIG,
  ]) as Buffer;
}
export function buildRecoveryLeafForProfile(
  profile: VaultRecoveryProfile,
): Buffer {
  if (profile.profileVersion === "COVE_V3_VAULT_PROFILE_DEV1") {
    if (profile.recoveryPubkeys.length !== 1)
      throw new Error("DEV1 requires exactly one recovery key");
    return buildDev1RecoveryLeaf(profile.recoveryPubkeys[0]!);
  }
  if (profile.profileVersion === "COVE_V3_VAULT_PROFILE_MAINNET1") {
    return buildThresholdRecoveryLeaf(
      profile.recoveryCsvBlocks,
      profile.recoveryThreshold,
      profile.recoveryPubkeys,
    );
  }
  throw new Error(`unknown vault profile ${profile.profileVersion}`);
}
export function dev1RecoveryProfile(ownerXOnly: Buffer): VaultRecoveryProfile {
  return {
    profileVersion: "COVE_V3_VAULT_PROFILE_DEV1",
    recoveryCsvBlocks: 144,
    recoveryThreshold: 1,
    recoveryPubkeys: [Buffer.from(ownerXOnly)],
  };
}
