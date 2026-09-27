import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { numsInternalKey } from "./nums.js";
import { buildExecutionLeaf, buildRecoveryLeaf } from "./leaves.js";
import {
  buildRecoveryLeafForProfile,
  dev1RecoveryProfile,
  type VaultRecoveryProfile,
} from "./vaultProfile.js";
import {
  LEAF_VERSION_TAPSCRIPT,
  merklePaths,
  tapBranchHash,
  tapleafHash,
  taprootMerkleRoot,
  tweakKey,
} from "./taproot.js";
bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);
export interface CoveVaultLeaf {
  script: Buffer;
  tapleafHash: Buffer;
}
export interface CoveVault {
  numsKey: Buffer;
  executionLeaf: CoveVaultLeaf;
  recoveryLeaf: CoveVaultLeaf;
  merkleRoot: Buffer;
  outputKey: Buffer;
  outputParity: number;
  scriptPubKey: Buffer;
  address: string;
  executionControlBlock: Buffer;
  recoveryControlBlock: Buffer;
}
export interface BuildCoveVaultParams {
  policyIdentityHash: Buffer;
  guardianXOnly: Buffer;
  ownerXOnly: Buffer;
  network?: bitcoin.networks.Network;
}
export function buildCoveVault(params: BuildCoveVaultParams): CoveVault {
  const numsKey = numsInternalKey();
  const executionScript = buildExecutionLeaf(
    params.policyIdentityHash,
    params.guardianXOnly,
  );
  const recoveryScript = buildRecoveryLeaf(params.ownerXOnly);
  const executionTapleaf = tapleafHash(executionScript, LEAF_VERSION_TAPSCRIPT);
  const recoveryTapleaf = tapleafHash(recoveryScript, LEAF_VERSION_TAPSCRIPT);
  const merkleRoot = tapBranchHash(executionTapleaf, recoveryTapleaf);
  const { outputKey, parity } = tweakKey(numsKey, merkleRoot);
  const controlBlockVersion = LEAF_VERSION_TAPSCRIPT | parity;
  const executionControlBlock = Buffer.concat([
    Buffer.from([controlBlockVersion]),
    numsKey,
    recoveryTapleaf,
  ]);
  const recoveryControlBlock = Buffer.concat([
    Buffer.from([controlBlockVersion]),
    numsKey,
    executionTapleaf,
  ]);
  const scriptPubKey = Buffer.concat([Buffer.from([0x51, 0x20]), outputKey]);
  const network = params.network ?? bitcoin.networks.regtest;
  const address = bitcoin.address.toBech32(outputKey, 1, network.bech32);
  return {
    numsKey,
    executionLeaf: { script: executionScript, tapleafHash: executionTapleaf },
    recoveryLeaf: { script: recoveryScript, tapleafHash: recoveryTapleaf },
    merkleRoot,
    outputKey,
    outputParity: parity,
    scriptPubKey,
    address,
    executionControlBlock,
    recoveryControlBlock,
  };
}
export interface CoveVaultV3 {
  numsKey: Buffer;
  mintLeaf: CoveVaultLeaf;
  redeemLeaf: CoveVaultLeaf;
  recoveryLeaf: CoveVaultLeaf;
  merkleRoot: Buffer;
  outputKey: Buffer;
  outputParity: number;
  scriptPubKey: Buffer;
  address: string;
  mintControlBlock: Buffer;
  redeemControlBlock: Buffer;
  recoveryControlBlock: Buffer;
}
export interface BuildCoveVaultV3Params {
  mintPolicyIdentityHash: Buffer;
  redeemPolicyIdentityHash: Buffer;
  guardianXOnly: Buffer;
  ownerXOnly: Buffer;
  recoveryProfile?: VaultRecoveryProfile;
  network?: bitcoin.networks.Network;
}
export function buildCoveVaultV3(params: BuildCoveVaultV3Params): CoveVaultV3 {
  const numsKey = numsInternalKey();
  const mintScript = buildExecutionLeaf(
    params.mintPolicyIdentityHash,
    params.guardianXOnly,
  );
  const redeemScript = buildExecutionLeaf(
    params.redeemPolicyIdentityHash,
    params.guardianXOnly,
  );
  const recoveryProfile =
    params.recoveryProfile ?? dev1RecoveryProfile(params.ownerXOnly);
  const recoveryScript = buildRecoveryLeafForProfile(recoveryProfile);
  const mintTapleaf = tapleafHash(mintScript, LEAF_VERSION_TAPSCRIPT);
  const redeemTapleaf = tapleafHash(redeemScript, LEAF_VERSION_TAPSCRIPT);
  const recoveryTapleaf = tapleafHash(recoveryScript, LEAF_VERSION_TAPSCRIPT);
  const merkleRoot = taprootMerkleRoot([
    mintTapleaf,
    redeemTapleaf,
    recoveryTapleaf,
  ]);
  const { outputKey, parity } = tweakKey(numsKey, merkleRoot);
  const paths = merklePaths([mintTapleaf, redeemTapleaf, recoveryTapleaf]);
  const versionByte = LEAF_VERSION_TAPSCRIPT | parity;
  const controlBlockFor = (tapleaf: Buffer): Buffer =>
    Buffer.concat([
      Buffer.from([versionByte]),
      numsKey,
      ...paths.get(tapleaf.toString("hex"))!,
    ]);
  const scriptPubKey = Buffer.concat([Buffer.from([0x51, 0x20]), outputKey]);
  const network = params.network ?? bitcoin.networks.regtest;
  const address = bitcoin.address.toBech32(outputKey, 1, network.bech32);
  return {
    numsKey,
    mintLeaf: { script: mintScript, tapleafHash: mintTapleaf },
    redeemLeaf: { script: redeemScript, tapleafHash: redeemTapleaf },
    recoveryLeaf: { script: recoveryScript, tapleafHash: recoveryTapleaf },
    merkleRoot,
    outputKey,
    outputParity: parity,
    scriptPubKey,
    address,
    mintControlBlock: controlBlockFor(mintTapleaf),
    redeemControlBlock: controlBlockFor(redeemTapleaf),
    recoveryControlBlock: controlBlockFor(recoveryTapleaf),
  };
}
