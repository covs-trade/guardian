import { AppError } from "./errors.js";
import {
  validateMainnetProfile,
  type MainnetProfile,
} from "@crclaunch/cove-mainnet";
export type { MainnetProfile } from "@crclaunch/cove-mainnet";
export type MainnetStage =
  | "DISABLED"
  | "READ_ONLY"
  | "SHADOW"
  | "CANARY_READY"
  | "CANARY_ACTIVE"
  | "CANARY_COMPLETE"
  | "PUBLIC_READY"
  | "PUBLIC_ACTIVE";
export const OWNER_DECISION_KEYS = [
  "activationHeight",
  "guardianXOnly",
  "recovery.pubkeys",
  "recovery.csvBlocks",
  "feeScript",
  "buyFeeBps",
  "redeemFeeBps",
  "p2pFeeBps",
  "canary.allowedWalletScripts",
  "canary.allowedTokenIds",
  "canary.maxBackingSats",
  "canary.maxSingleBuySats",
  "canary.maxSingleRedeemPayoutSats",
  "canary.maxP2pSettlementSats",
] as const;
export function mainnetProfileComplete(
  p: MainnetProfile,
  opts: {
    allowTestKeys?: boolean;
  } = {},
): boolean {
  return validateMainnetProfile(p, opts).ok;
}
export function missingOwnerDecisions(p: MainnetProfile): string[] {
  return validateMainnetProfile(p).errors.filter((e) =>
    e.startsWith("OWNER_DECISION_REQUIRED"),
  );
}
export interface MainnetHealth {
  primaryCoreHealthy: boolean;
  secondaryCoreHealthy: boolean;
  coreAgreement: boolean;
  indexerHealthy: boolean;
  stateRootVerified: boolean;
  workerHealthy: boolean;
  guardianHealthy: boolean;
  guardianProfileHashMatches: boolean;
  guardianKeyMatches: boolean;
  auditHealthy: boolean;
  signingJournalHealthy: boolean;
  profileHashMatches: boolean;
}
export function deriveMainnetStage(
  p: MainnetProfile,
  canaryActive: boolean,
  health: MainnetHealth,
  opts: {
    allowTestKeys?: boolean;
  } = {},
): MainnetStage {
  if (!mainnetProfileComplete(p, opts)) return "DISABLED";
  if (!health.profileHashMatches) return "DISABLED";
  if (
    !health.primaryCoreHealthy ||
    !health.secondaryCoreHealthy ||
    !health.coreAgreement ||
    !health.indexerHealthy
  )
    return "READ_ONLY";
  if (!health.stateRootVerified || !health.workerHealthy) return "READ_ONLY";
  if (
    !health.guardianHealthy ||
    !health.guardianProfileHashMatches ||
    !health.guardianKeyMatches ||
    !health.auditHealthy ||
    !health.signingJournalHealthy
  )
    return "READ_ONLY";
  if (!canaryActive) return "CANARY_READY";
  return "CANARY_ACTIVE";
}
export function assertNoLocalGuardianKeyOnMainnet(
  network: string,
  guardianPrivateKey: Buffer | null,
): void {
  if (network === "mainnet" && guardianPrivateKey !== null) {
    throw new AppError(
      "MAINNET_DISABLED",
      "mainnet must use the remote Guardian service; local Guardian key is forbidden",
    );
  }
}
export function assertNoRecoveryPrivateKeyOnMainnet(
  network: string,
  recoveryPrivateKey: Buffer | null,
): void {
  if (network === "mainnet" && recoveryPrivateKey !== null) {
    throw new AppError(
      "MAINNET_DISABLED",
      "mainnet recovery private keys are offline-only and forbidden in the app",
    );
  }
}
