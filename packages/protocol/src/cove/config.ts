import type { Sats } from "@crclaunch/curve";
export interface CoveConfig {
  network: "signet" | "regtest" | "mutinynet" | "mainnet";
  genesisHeight: number;
  settlementScript: string;
  treasuryScript: string;
  launchFeeSats: Sats;
  primaryMintFeeBps: bigint;
  minContributionSats: Sats;
  maxFeeRateSatVb: bigint;
  maxMinerFeeSats: Sats;
}
export const COVE_V1_SIGNET_GENESIS_HEIGHT = 323323;
export const COVE_V1_SIGNET_CONFIG: CoveConfig = {
  network: "signet",
  genesisHeight: COVE_V1_SIGNET_GENESIS_HEIGHT,
  settlementScript: "001468a5c1ce1047fa51ba0a2170329c3f9396c2a0b8",
  treasuryScript: "0014c168131539d3062ff2c66bd0833a9c5d8c355f46",
  launchFeeSats: 10000n,
  primaryMintFeeBps: 100n,
  minContributionSats: 1000n,
  maxFeeRateSatVb: 50n,
  maxMinerFeeSats: 50000n,
};
export const COVE_MUTINYNET_GENESIS_HEIGHT = 3449383;
export const COVE_MUTINYNET_CONFIG: CoveConfig = {
  network: "mutinynet",
  genesisHeight: COVE_MUTINYNET_GENESIS_HEIGHT,
  settlementScript: "001468a5c1ce1047fa51ba0a2170329c3f9396c2a0b8",
  treasuryScript: "0014c168131539d3062ff2c66bd0833a9c5d8c355f46",
  launchFeeSats: 10000n,
  primaryMintFeeBps: 100n,
  minContributionSats: 1000n,
  maxFeeRateSatVb: 50n,
  maxMinerFeeSats: 50000n,
};
export const COVE_V1_REGTEST_CONFIG: CoveConfig = {
  network: "regtest",
  genesisHeight: 1,
  settlementScript: "0014" + "11".repeat(20),
  treasuryScript: "0014" + "22".repeat(20),
  launchFeeSats: 10000n,
  primaryMintFeeBps: 100n,
  minContributionSats: 1000n,
  maxFeeRateSatVb: 50n,
  maxMinerFeeSats: 50000n,
};
export const COVE_V1_MAINNET_GENESIS_HEIGHT = 0;
export const COVE_V1_MAINNET_SETTLEMENT_SCRIPT = "";
export const COVE_V1_MAINNET_TREASURY_SCRIPT = "";
export const COVE_V1_MAINNET_CONFIG: CoveConfig = {
  network: "mainnet",
  genesisHeight: COVE_V1_MAINNET_GENESIS_HEIGHT,
  settlementScript: COVE_V1_MAINNET_SETTLEMENT_SCRIPT,
  treasuryScript: COVE_V1_MAINNET_TREASURY_SCRIPT,
  launchFeeSats: 10000n,
  primaryMintFeeBps: 100n,
  minContributionSats: 1000n,
  maxFeeRateSatVb: 50n,
  maxMinerFeeSats: 50000n,
};
export function isCoveMainnetActivated(
  cfg: CoveConfig = COVE_V1_MAINNET_CONFIG,
): boolean {
  return (
    cfg.network === "mainnet" &&
    cfg.genesisHeight >= 1 &&
    cfg.settlementScript.length > 0 &&
    cfg.treasuryScript.length > 0
  );
}
export function configDomain(cfg: CoveConfig): string {
  return [
    "cove:1",
    cfg.network,
    cfg.genesisHeight.toString(),
    cfg.settlementScript,
    cfg.treasuryScript,
    cfg.launchFeeSats.toString(),
    cfg.primaryMintFeeBps.toString(),
    cfg.minContributionSats.toString(),
  ].join(":");
}
