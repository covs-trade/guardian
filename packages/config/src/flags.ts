import type { ProtocolHealth, RuntimeConfig } from "./types.js";
export type WriteOperation = "deploy" | "mint" | "market" | "graduation";
export type ProductMode = "DEMO" | "READ_ONLY_MAINNET" | "CANONICAL_CRC";
export type CoveMainnetActivationStage =
  "READ_ONLY" | "OWNER_CANARY" | "PUBLIC_WRITES";
export function coveMainnetActivationStage(
  config: RuntimeConfig,
): CoveMainnetActivationStage {
  const { mainnetEnabled, deployMainnet, mintMainnet, transferMainnet } =
    config.coveFlags;
  const anyPublic = deployMainnet || mintMainnet || transferMainnet;
  if (!mainnetEnabled) return "READ_ONLY";
  if (!anyPublic) return "OWNER_CANARY";
  return "PUBLIC_WRITES";
}
export function productMode(config: RuntimeConfig): ProductMode {
  if (config.network === "mock" || config.network === "test") return "DEMO";
  if (config.network === "mainnet-read-only") return "READ_ONLY_MAINNET";
  return "CANONICAL_CRC";
}
function flagFor(config: RuntimeConfig, op: WriteOperation): boolean {
  switch (op) {
    case "deploy":
      return config.flags.deployMainnet;
    case "mint":
      return config.flags.mintMainnet;
    case "market":
      return config.flags.marketMainnet;
    case "graduation":
      return config.flags.graduationMainnet;
  }
}
export function canWriteMainnet(
  config: RuntimeConfig,
  op: WriteOperation,
  health: ProtocolHealth,
): boolean {
  return (
    config.protocolVerified &&
    flagFor(config, op) &&
    health.synced &&
    health.stateValid
  );
}
export function isReadOnly(config: RuntimeConfig): boolean {
  return config.network === "mainnet-read-only";
}
export function isMock(config: RuntimeConfig): boolean {
  return config.network === "mock";
}
export function writeModeLabel(
  config: RuntimeConfig,
  health: ProtocolHealth,
): string {
  const anyMainnetWrite = Object.values(config.flags).some(Boolean);
  if (!anyMainnetWrite) return "disabled";
  if (!config.protocolVerified) return "awaiting-verification";
  if (!health.synced || !health.stateValid) return "degraded";
  return "enabled";
}
