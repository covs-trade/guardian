import { resolve as resolvePath } from "node:path";
import * as bitcoin from "bitcoinjs-lib";
import {
  loadMainnetProfile,
  parseMainnetProfileJson,
  validateMainnetProfile,
  hashMainnetProfile,
  type MainnetProfile,
  type MainnetProfileValidationResult,
} from "./profile.js";
export const COMMITTED_MAINNET_PROFILE_JSON = `{
  "profileVersion": 1,
  "chainIdentity": "bitcoin-mainnet",
  "activationHeight": null,
  "guardianXOnly": null,
  "recovery": {
    "threshold": 1,
    "csvBlocks": null,
    "pubkeys": []
  },
  "feeScript": null,
  "buyFeeBps": null,
  "redeemFeeBps": null,
  "p2pFeeBps": null,
  "canary": {
    "allowedWalletScripts": [],
    "allowedTokenIds": [],
    "maxBackingSats": null,
    "maxSingleBuySats": "200000",
    "maxSingleRedeemPayoutSats": null,
    "maxP2pSettlementSats": null,
    "maxMintAtoms": "2100000000000000",
    "minMintGrossSats": "5000"
  },
  "policyVersion": 3,
  "vaultProfileVersion": "COVE_V3_VAULT_PROFILE_MAINNET1",
  "carrierSats": "1000",
  "anchorSats": "10000",
  "maxProtocolSupplyAtoms": "2100000000000000",
  "reserveAllocationAtoms": "0",
  "mintCmr": "7fb27adf2db5458882daf976ba9325815f111b2f3b16eedb72e75f96de4269b2",
  "redeemCmr": "37e681b3e70a34acc3b38680c06fbe4f1b2799bede2607c6c9ed7fcac8c95d56"
}`;
export interface CommittedMainnetProfile {
  profile: MainnetProfile;
  validation: MainnetProfileValidationResult;
  profileHash: string;
}
export const FEE_ADDRESS_ENV = "COVE_FEE_ADDRESS";
export function feeScriptFromAddress(
  address: string,
  network: bitcoin.networks.Network,
): string {
  try {
    return Buffer.from(
      bitcoin.address.toOutputScript(address.trim(), network),
    ).toString("hex");
  } catch {
    throw new Error(
      `${FEE_ADDRESS_ENV} "${address}" is not a valid address for this network`,
    );
  }
}
export function committedMainnetProfile(
  opts: {
    feeAddress?: string;
  } = {},
): CommittedMainnetProfile {
  const profile = parseMainnetProfileJson(COMMITTED_MAINNET_PROFILE_JSON);
  if (opts.feeAddress)
    profile.feeScript = feeScriptFromAddress(
      opts.feeAddress,
      bitcoin.networks.bitcoin,
    );
  return {
    profile,
    validation: validateMainnetProfile(profile),
    profileHash: hashMainnetProfile(profile),
  };
}
export const TEST_ONLY_PROFILE_ENV = "COVE_TEST_ONLY_PROFILE_PATH";
export interface ResolvedMainnetProfile extends CommittedMainnetProfile {
  source: "committed" | "test-only";
}
export function resolveMainnetProfile(params: {
  network: string;
  testOnlyPath?: string;
  baseDir?: string;
  feeAddress?: string;
}): ResolvedMainnetProfile {
  if (!params.testOnlyPath) {
    return {
      ...committedMainnetProfile({ feeAddress: params.feeAddress }),
      source: "committed",
    };
  }
  if (params.network === "mainnet") {
    throw new Error(
      `${TEST_ONLY_PROFILE_ENV} is refused on mainnet: mainnet runs only the committed profile`,
    );
  }
  const path = params.baseDir
    ? resolvePath(params.baseDir, params.testOnlyPath)
    : params.testOnlyPath;
  const { profile, validation } = loadMainnetProfile(path, {
    allowTestKeys: true,
  });
  return {
    profile,
    validation,
    profileHash: hashMainnetProfile(profile),
    source: "test-only",
  };
}
