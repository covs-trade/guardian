import type { Sats } from "@crclaunch/curve";
export interface ProtocolConfig {
  profile: string;
  decimals: number;
  treasuryAddress: string;
  reserveAddress: string;
  protocolFeeAddress: string;
  launchFeeSats: Sats;
  primaryMintFeeBps: bigint;
  marketplaceFeeBps: bigint;
  finalityConfirmations: number;
}
export const CRC_LAUNCH_V1_PROFILE = "crc-launch-v1";
export const MOCK_TREASURY_ADDRESS =
  "bc1qm0cktreasury000000000000000000000000000000000000";
export const MOCK_RESERVE_ADDRESS =
  "bc1qm0ckreserve000000000000000000000000000000000000000";
export const MOCK_PROTOCOL_FEE_ADDRESS =
  "bc1qm0ckprotocol0000000000000000000000000000000000";
export const DEFAULT_MOCK_PROTOCOL_CONFIG: ProtocolConfig = Object.freeze({
  profile: CRC_LAUNCH_V1_PROFILE,
  decimals: 8,
  treasuryAddress: MOCK_TREASURY_ADDRESS,
  reserveAddress: MOCK_RESERVE_ADDRESS,
  protocolFeeAddress: MOCK_PROTOCOL_FEE_ADDRESS,
  launchFeeSats: 10000n,
  primaryMintFeeBps: 100n,
  marketplaceFeeBps: 0n,
  finalityConfirmations: 6,
});
