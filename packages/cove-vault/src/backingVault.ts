import type * as bitcoin from "bitcoinjs-lib";
import { stateHashV2, type CoveStateV2 } from "@crclaunch/cove-covenant";
import {
  COVE_POLICY_CMRS,
  COVE_POLICY_V3,
  OP_MINT,
  OP_REDEEM,
  policyIdentityHash,
} from "./policyIdentity.js";
import { buildCoveVaultV3, type CoveVaultV3 } from "./vault.js";
import type { VaultRecoveryProfile } from "./vaultProfile.js";
export function buildBackingVaultV3(params: {
  state: CoveStateV2;
  guardianXOnly: Buffer;
  recoveryKeyXOnly: Buffer;
  recoveryProfile?: VaultRecoveryProfile;
  network?: bitcoin.networks.Network;
}): CoveVaultV3 {
  const currentStateHash = Buffer.from(stateHashV2(params.state), "hex");
  const mintPi = policyIdentityHash({
    version: COVE_POLICY_V3,
    operation: OP_MINT,
    tokenId: params.state.tokenId,
    currentStateHash,
    cmr: Buffer.from(COVE_POLICY_CMRS[COVE_POLICY_V3]!.mint, "hex"),
  });
  const redeemPi = policyIdentityHash({
    version: COVE_POLICY_V3,
    operation: OP_REDEEM,
    tokenId: params.state.tokenId,
    currentStateHash,
    cmr: Buffer.from(COVE_POLICY_CMRS[COVE_POLICY_V3]!.redeem!, "hex"),
  });
  return buildCoveVaultV3({
    mintPolicyIdentityHash: mintPi,
    redeemPolicyIdentityHash: redeemPi,
    guardianXOnly: params.guardianXOnly,
    ownerXOnly: params.recoveryKeyXOnly,
    recoveryProfile: params.recoveryProfile,
    network: params.network,
  });
}
