import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { randomBytes } from "node:crypto";
import { numsInternalKey } from "./nums.js";
import { buildExecutionLeaf } from "./leaves.js";
import { buildRecoveryLeafForProfile, sortRecoveryPubkeys, type VaultRecoveryProfile } from "./vaultProfile.js";
import { LEAF_VERSION_TAPSCRIPT, taggedHash, tapBranchHash, tapleafHash, tweakKey } from "./taproot.js";
import type { CoveVault } from "./vault.js";

bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);

export interface Crc20VaultState {
  deploymentTag: Buffer;
  launchSalt: Buffer;
  mintedAtoms: bigint;
  vaultAtoms: bigint;
  backingSats: bigint;
  anchorSats: bigint;
}

const LOT_ATOMS = 100_000_000_000n;
const MAX_ATOMS = 2_100_000_000_000_000n;

export function randomCrc20LaunchSalt(): Buffer {
  return randomBytes(32);
}

export function crc20DeploymentTag(markerBytes: Buffer): Buffer {
  if (markerBytes.length === 0 || markerBytes.length > 256)
    throw new Error("invalid CRC deployment marker length");
  return taggedHash("CoveCRC20Deployment/v1", markerBytes);
}

function uint64(value: bigint): Buffer {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn)
    throw new Error("CRC vault integer is outside uint64 range");
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(value);
  return bytes;
}

export function crc20VaultStateCommitment(state: Crc20VaultState): Buffer {
  if (state.deploymentTag.length !== 32)
    throw new Error("CRC deployment tag must be 32 bytes");
  if (state.launchSalt.length !== 32 || state.launchSalt.every((byte) => byte === 0))
    throw new Error("CRC launch salt must be a nonzero 32-byte value");
  if (state.mintedAtoms < 0n || state.mintedAtoms > MAX_ATOMS ||
    state.vaultAtoms < 0n || state.vaultAtoms > state.mintedAtoms ||
    state.mintedAtoms % LOT_ATOMS !== 0n || state.vaultAtoms % LOT_ATOMS !== 0n)
    throw new Error("invalid CRC vault supply");
  if (state.backingSats < 0n || state.anchorSats <= 0n)
    throw new Error("invalid CRC vault backing or anchor");
  return taggedHash("CoveCRC20VaultState/v1", Buffer.concat([
    state.deploymentTag,
    state.launchSalt,
    uint64(state.mintedAtoms),
    uint64(state.vaultAtoms),
    uint64(state.backingSats),
    uint64(state.anchorSats),
  ]));
}

export function buildCrc20BackingVault(params: {
  state: Crc20VaultState;
  guardianXOnly: Buffer;
  recoveryProfile: VaultRecoveryProfile;
  network?: bitcoin.networks.Network;
}): CoveVault {
  if (params.guardianXOnly.length !== 32 || !ecc.isXOnlyPoint(params.guardianXOnly))
    throw new Error("invalid CRC Guardian key");
  const recoveryKeys = sortRecoveryPubkeys(params.recoveryProfile.recoveryPubkeys);
  if (recoveryKeys.some((key) => key.equals(params.guardianXOnly)))
    throw new Error("CRC Guardian and recovery keys must be distinct");
  const commitment = crc20VaultStateCommitment(params.state);
  const executionScript = buildExecutionLeaf(commitment, params.guardianXOnly);
  const recoveryScript = buildRecoveryLeafForProfile(params.recoveryProfile);
  const executionHash = tapleafHash(executionScript, LEAF_VERSION_TAPSCRIPT);
  const recoveryHash = tapleafHash(recoveryScript, LEAF_VERSION_TAPSCRIPT);
  const merkleRoot = tapBranchHash(executionHash, recoveryHash);
  const numsKey = numsInternalKey();
  const { outputKey, parity } = tweakKey(numsKey, merkleRoot);
  const versionByte = LEAF_VERSION_TAPSCRIPT | parity;
  const scriptPubKey = Buffer.concat([Buffer.from([0x51, 0x20]), outputKey]);
  const network = params.network ?? bitcoin.networks.regtest;
  return {
    numsKey,
    executionLeaf: { script: executionScript, tapleafHash: executionHash },
    recoveryLeaf: { script: recoveryScript, tapleafHash: recoveryHash },
    merkleRoot,
    outputKey,
    outputParity: parity,
    scriptPubKey,
    address: bitcoin.address.toBech32(outputKey, 1, network.bech32),
    executionControlBlock: Buffer.concat([Buffer.from([versionByte]), numsKey, recoveryHash]),
    recoveryControlBlock: Buffer.concat([Buffer.from([versionByte]), numsKey, executionHash]),
  };
}
