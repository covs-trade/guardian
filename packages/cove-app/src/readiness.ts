import type { BlockchainInfo, CoreRpcProvider } from "@crclaunch/bitcoin";
import type { MainnetProfile } from "@crclaunch/cove-mainnet";
import {
  mainnetProfileComplete,
  deriveMainnetStage,
  type MainnetStage,
} from "./mainnet.js";
export const BITCOIN_MAINNET_GENESIS_HASH =
  "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f";
export interface CoreAgreementResult {
  agreed: boolean;
  primaryHeight: number | null;
  secondaryHeight: number | null;
  comparisonHeight: number | null;
  comparisonHash: string | null;
  detail: string | null;
}
export async function verifyMainnetGenesis(
  provider: CoreRpcProvider,
): Promise<boolean> {
  try {
    return (await provider.getBlockHash(0)) === BITCOIN_MAINNET_GENESIS_HASH;
  } catch {
    return false;
  }
}
export async function checkCoreAgreement(
  primary: CoreRpcProvider,
  secondary: CoreRpcProvider,
  opts: {
    maxHeightDelta?: number;
    primaryInfo?: BlockchainInfo;
  } = {},
): Promise<CoreAgreementResult> {
  const maxDelta = opts.maxHeightDelta ?? 3;
  const empty = {
    primaryHeight: null,
    secondaryHeight: null,
    comparisonHeight: null,
    comparisonHash: null,
  };
  let pi: BlockchainInfo;
  let si: BlockchainInfo;
  try {
    pi = opts.primaryInfo ?? (await primary.getBlockchainInfo());
    si = await secondary.getBlockchainInfo();
  } catch (e) {
    return { agreed: false, ...empty, detail: (e as Error).message };
  }
  if (pi.chain !== si.chain) {
    return {
      agreed: false,
      ...empty,
      primaryHeight: pi.blocks,
      secondaryHeight: si.blocks,
      detail: `chain mismatch ${pi.chain} vs ${si.chain}`,
    };
  }
  const delta = Math.abs(pi.blocks - si.blocks);
  if (delta > maxDelta) {
    return {
      agreed: false,
      ...empty,
      primaryHeight: pi.blocks,
      secondaryHeight: si.blocks,
      detail: `height delta ${delta} > ${maxDelta}`,
    };
  }
  const comparisonHeight = Math.min(pi.blocks, si.blocks);
  try {
    const [ph, sh] = await Promise.all([
      pi.blocks === comparisonHeight
        ? pi.bestBlockHash
        : primary.getBlockHash(comparisonHeight),
      si.blocks === comparisonHeight
        ? si.bestBlockHash
        : secondary.getBlockHash(comparisonHeight),
    ]);
    const agreed = ph === sh;
    return {
      agreed,
      primaryHeight: pi.blocks,
      secondaryHeight: si.blocks,
      comparisonHeight,
      comparisonHash: ph,
      detail: agreed ? null : `hash mismatch at height ${comparisonHeight}`,
    };
  } catch (e) {
    return {
      agreed: false,
      primaryHeight: pi.blocks,
      secondaryHeight: si.blocks,
      comparisonHeight,
      comparisonHash: null,
      detail: (e as Error).message,
    };
  }
}
export interface MainnetReadinessInput {
  profile: MainnetProfile;
  profileHash: string;
  expectedProfileHash: string;
  releaseManifestOk: boolean;
  primaryCoreHealthy: boolean;
  secondaryCoreHealthy: boolean;
  coreAgreement: boolean;
  indexerHealthy: boolean;
  stateRootVerified: boolean;
  workerHealthy: boolean;
  guardianHealthy: boolean;
  guardianProfileHash: string | null;
  guardianXOnly: string | null;
  custodyBackendReady: boolean;
  auditHealthy: boolean;
  signingJournalHealthy: boolean;
  canaryActive: boolean;
  allowTestKeys?: boolean;
}
export interface MainnetReadiness {
  stage: MainnetStage;
  staticProfileReady: boolean;
  releaseManifestOk: boolean;
  profileHashMatches: boolean;
  guardianProfileHashMatches: boolean;
  guardianKeyMatches: boolean;
  primaryCoreHealthy: boolean;
  secondaryCoreHealthy: boolean;
  coreAgreement: boolean;
  indexerHealthy: boolean;
  stateRootVerified: boolean;
  workerHealthy: boolean;
  guardianHealthy: boolean;
  custodyBackendReady: boolean;
  auditHealthy: boolean;
  signingJournalHealthy: boolean;
  canaryActive: boolean;
  mutationsEnabled: boolean;
}
export function computeMainnetReadiness(
  input: MainnetReadinessInput,
): MainnetReadiness {
  const keys = { allowTestKeys: input.allowTestKeys === true };
  const staticProfileReady = mainnetProfileComplete(input.profile, keys);
  const profileHashMatches = input.profileHash === input.expectedProfileHash;
  const guardianProfileHashMatches =
    input.guardianProfileHash !== null &&
    input.guardianProfileHash === input.expectedProfileHash;
  const guardianKeyMatches =
    input.guardianXOnly !== null &&
    input.profile.guardianXOnly !== null &&
    input.guardianXOnly.toLowerCase() ===
      input.profile.guardianXOnly.toLowerCase();
  const stage = deriveMainnetStage(
    input.profile,
    input.canaryActive,
    {
      primaryCoreHealthy: input.primaryCoreHealthy,
      secondaryCoreHealthy: input.secondaryCoreHealthy,
      coreAgreement: input.coreAgreement,
      indexerHealthy: input.indexerHealthy,
      stateRootVerified: input.stateRootVerified,
      workerHealthy: input.workerHealthy,
      guardianHealthy: input.guardianHealthy,
      guardianProfileHashMatches,
      guardianKeyMatches,
      auditHealthy: input.auditHealthy,
      signingJournalHealthy: input.signingJournalHealthy,
      profileHashMatches,
    },
    keys,
  );
  return {
    stage,
    staticProfileReady,
    releaseManifestOk: input.releaseManifestOk,
    profileHashMatches,
    guardianProfileHashMatches,
    guardianKeyMatches,
    primaryCoreHealthy: input.primaryCoreHealthy,
    secondaryCoreHealthy: input.secondaryCoreHealthy,
    coreAgreement: input.coreAgreement,
    indexerHealthy: input.indexerHealthy,
    stateRootVerified: input.stateRootVerified,
    workerHealthy: input.workerHealthy,
    guardianHealthy: input.guardianHealthy,
    custodyBackendReady: input.custodyBackendReady,
    auditHealthy: input.auditHealthy,
    signingJournalHealthy: input.signingJournalHealthy,
    canaryActive: input.canaryActive,
    mutationsEnabled: stage === "CANARY_ACTIVE",
  };
}
export type ReadinessState =
  | "NOT_READY"
  | "READY_EXCEPT_FOR_OPERATOR_CEREMONY"
  | "READY_FOR_CONTROLLED_MAINNET_CANARY";
export function deriveReadinessState(r: MainnetReadiness): ReadinessState {
  if (!r.staticProfileReady) return "READY_EXCEPT_FOR_OPERATOR_CEREMONY";
  if (r.stage === "CANARY_READY" || r.stage === "CANARY_ACTIVE")
    return "READY_FOR_CONTROLLED_MAINNET_CANARY";
  return "NOT_READY";
}
