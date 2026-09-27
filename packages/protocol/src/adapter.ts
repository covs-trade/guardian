import type { ProtocolHealth } from "@crclaunch/config";
import type {
  BuildBuyInput,
  BuildCancelInput,
  BuildDeployInput,
  BuildMintInput,
  BuildSellInput,
  DecodedProtocolTransaction,
  DecodedSignedTransaction,
  ProtocolEvent,
  ProtocolListing,
  ProtocolToken,
  ProtocolTransactionStatus,
  UnsignedProtocolTransaction,
  ValidationResult,
  VerificationStatus,
} from "./types.js";
export interface CRCProtocolAdapter {
  readonly id: string;
  getVerificationStatus(): VerificationStatus;
  getHealth(): Promise<ProtocolHealth>;
  getCurrentHeight(): Promise<bigint>;
  getStateHash(): Promise<string>;
  getTokenByTicker(ticker: string): Promise<ProtocolToken | null>;
  getTokenByDeployment(txid: string): Promise<ProtocolToken | null>;
  getListing(listingId: string): Promise<ProtocolListing | null>;
  buildDeploy(input: BuildDeployInput): Promise<UnsignedProtocolTransaction>;
  validateDeploy(tx: UnsignedProtocolTransaction): Promise<ValidationResult>;
  buildMint(input: BuildMintInput): Promise<UnsignedProtocolTransaction>;
  validateMint(tx: UnsignedProtocolTransaction): Promise<ValidationResult>;
  buildSellListing(input: BuildSellInput): Promise<UnsignedProtocolTransaction>;
  validateSellListing(
    tx: UnsignedProtocolTransaction,
  ): Promise<ValidationResult>;
  buildBuySettlement(
    input: BuildBuyInput,
  ): Promise<UnsignedProtocolTransaction>;
  validateBuySettlement(
    tx: UnsignedProtocolTransaction,
  ): Promise<ValidationResult>;
  buildCancelListing(
    input: BuildCancelInput,
  ): Promise<UnsignedProtocolTransaction>;
  validateCancelListing(
    tx: UnsignedProtocolTransaction,
  ): Promise<ValidationResult>;
  broadcast(signedTxHex: string): Promise<string>;
  getTransaction(txid: string): Promise<ProtocolTransactionStatus>;
  getEvents(fromHeight: bigint, toHeight: bigint): Promise<ProtocolEvent[]>;
  decodeTransaction(rawTx: string): Promise<DecodedProtocolTransaction>;
  decodeSignedTransaction(rawTx: string): Promise<DecodedSignedTransaction>;
}
