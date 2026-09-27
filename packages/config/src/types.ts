export type Network = "mock" | "test" | "mainnet" | "mainnet-read-only";
export type ProtocolHealthState = "HEALTHY" | "DEGRADED" | "UNSAFE";
export interface ProtocolHealth {
  state: ProtocolHealthState;
  synced: boolean;
  stateValid: boolean;
  lagBlocks: bigint;
}
export interface FeatureFlags {
  deployMainnet: boolean;
  mintMainnet: boolean;
  marketMainnet: boolean;
  graduationMainnet: boolean;
}
export interface CoveFeatureFlags {
  mainnetEnabled: boolean;
  deployMainnet: boolean;
  mintMainnet: boolean;
  transferMainnet: boolean;
}
export interface CoveMainnetCanaryProof {
  deployTxid: string | null;
  mintTxid: string | null;
  transferTxid: string | null;
  stateRoot: string | null;
  replayRoot: string | null;
}
export interface BitcoinRpcConfig {
  url: string;
  user: string | null;
  password: string | null;
}
export interface S3Config {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
}
export interface RuntimeConfig {
  nodeEnv: "development" | "test" | "production";
  appUrl: string;
  appName: string;
  databaseUrl: string;
  redisUrl: string;
  network: Network;
  protocolUrl: string | null;
  protocolVerified: boolean;
  flags: FeatureFlags;
  coveFlags: CoveFeatureFlags;
  coveMainnetGenesisHeight: bigint | null;
  coveMainnetCanary: CoveMainnetCanaryProof;
  bitcoinRpc: BitcoinRpcConfig | null;
  explorerUrl: string;
  treasuryAddress: string | null;
  launchFeeSats: bigint;
  primaryMintFeeBps: bigint;
  finalityConfirmations: number;
  quoteTtlSeconds: number;
  quoteTtlBlocks: number;
  s3: S3Config | null;
  sentryDsn: string | null;
  adminAuthSecret: string | null;
}
