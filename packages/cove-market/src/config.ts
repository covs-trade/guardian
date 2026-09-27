import { COVE_FEE_CONFIG } from "@crclaunch/cove-economics";
import {
  CHAIN_BITCOIN_REGTEST,
  CHAIN_BITCOIN_SIGNET,
  CHAIN_BITCOIN_TESTNET,
  CHAIN_BITCOIN_MAINNET,
} from "@crclaunch/cove-wire";
export interface MarketConfig {
  enabled: boolean;
  network: "regtest" | "signet" | "testnet" | "mainnet";
  chainIdentity: string;
  p2pFeeBps: bigint;
  p2pFeeMinSats: bigint;
  feeScript: Buffer;
  reservationTtlSeconds: number;
  sellerSignTtlSeconds: number;
  maxListingBlocks: bigint;
  maxMinerFeeSats: bigint;
  maxP2pSettlementSats?: bigint;
}
function chainIdentityForNetwork(network: MarketConfig["network"]): string {
  switch (network) {
    case "regtest":
      return CHAIN_BITCOIN_REGTEST;
    case "signet":
      return CHAIN_BITCOIN_SIGNET;
    case "testnet":
      return CHAIN_BITCOIN_TESTNET;
    case "mainnet":
      return CHAIN_BITCOIN_MAINNET;
  }
}
export function defaultMarketConfig(
  network: MarketConfig["network"],
  feeScript: Buffer,
  chainIdentity: string = chainIdentityForNetwork(network),
): MarketConfig {
  return {
    enabled: true,
    network,
    chainIdentity,
    p2pFeeBps: COVE_FEE_CONFIG.p2pFeeBps,
    p2pFeeMinSats: COVE_FEE_CONFIG.p2pFeeMinSats,
    feeScript,
    reservationTtlSeconds: 300,
    sellerSignTtlSeconds: 24 * 60 * 60,
    maxListingBlocks: 21000n,
    maxMinerFeeSats: 20000n,
  };
}
export function mainnetMarketConfig(params: {
  p2pFeeBps: number;
  feeScript: Buffer;
  maxP2pSettlementSats: bigint;
  chainIdentity?: string;
}): MarketConfig {
  return {
    enabled: true,
    network: "mainnet",
    chainIdentity: params.chainIdentity ?? CHAIN_BITCOIN_MAINNET,
    p2pFeeBps: BigInt(params.p2pFeeBps),
    p2pFeeMinSats: COVE_FEE_CONFIG.p2pFeeMinSats,
    feeScript: params.feeScript,
    reservationTtlSeconds: 300,
    sellerSignTtlSeconds: 24 * 60 * 60,
    maxListingBlocks: 21000n,
    maxMinerFeeSats: 20000n,
    maxP2pSettlementSats: params.maxP2pSettlementSats,
  };
}
