import type { Network } from "@crclaunch/config";
import type { Sats, DisplayTokens, TxId } from "@crclaunch/curve";
export type {
  Network,
  ProtocolHealth,
  ProtocolHealthState,
} from "@crclaunch/config";
export type { Sats, DisplayTokens, TxId, BasisPoints } from "@crclaunch/curve";
export type ProtocolOperation =
  | "DEPLOY"
  | "MINT"
  | "TRANSFER"
  | "DEX_ASK"
  | "DEX_BID"
  | "DEX_CANCEL"
  | "GRADUATION";
export type OperationStatus = "VERIFIED" | "UNVERIFIED";
export type ProtocolTxStatus =
  "UNKNOWN" | "MEMPOOL" | "CONFIRMED" | "REJECTED" | "DROPPED";
export interface ProtocolToken {
  deploymentId: TxId;
  ticker: string;
  tickerNormalized: string;
  name: string | null;
  creatorAddress: string;
  network: Network;
  totalSupplyAtoms: DisplayTokens;
  publicSupplyAtoms: DisplayTokens;
  reserveSupplyAtoms: DisplayTokens;
  confirmedMintedAtoms: DisplayTokens;
  pendingMintedAtoms: DisplayTokens;
  currentStage: number;
  deployHeight: bigint | null;
  status: "LIVE" | "SOLD_OUT" | "GRADUATING" | "GRADUATED";
  stateHash: string;
}
export type ProtocolEventType =
  | "DEPLOY"
  | "MINT"
  | "TRANSFER"
  | "DEX_ASK"
  | "DEX_BID"
  | "DEX_CANCEL"
  | "GRADUATION";
export interface ProtocolEvent {
  network: Network;
  blockHeight: bigint;
  blockHash: string;
  txid: TxId;
  eventIndex: number;
  eventType: ProtocolEventType;
  deploymentId: TxId | null;
  walletFrom: string | null;
  walletTo: string | null;
  tokenAmountAtoms: DisplayTokens | null;
  btcAmountSats: Sats | null;
  payload: unknown;
}
export interface ProtocolTransactionStatus {
  txid: TxId;
  status: ProtocolTxStatus;
  confirmations: number;
  blockHeight: bigint | null;
}
export type OutputKind =
  | "curve-reserve"
  | "platform-fee"
  | "protocol-fee"
  | "launch-fee"
  | "token"
  | "buyer"
  | "seller"
  | "change"
  | "unknown";
export interface TransactionOutput {
  index: number;
  address: string | null;
  amountSats: Sats;
  kind: OutputKind;
  tokenAmountAtoms?: DisplayTokens;
}
export interface TransactionInput {
  txid: TxId;
  vout: number;
  address: string | null;
  amountSats: Sats;
}
export interface TransactionSummary {
  operation: ProtocolOperation;
  ticker?: string;
  tokenAmountAtoms?: DisplayTokens;
  curveContributionSats?: Sats;
  platformFeeSats?: Sats;
  protocolFeeSats?: Sats;
  minerFeeSats?: Sats;
  launchFeeSats?: Sats;
  totalSpendSats?: Sats;
  buyerReceivesAtoms?: DisplayTokens;
  sellerReceivesSats?: Sats;
  outputCount: number;
}
export interface UnsignedProtocolTransaction {
  operation: ProtocolOperation;
  network: Network;
  txHex: string | null;
  psbtBase64: string | null;
  inputs: TransactionInput[];
  outputs: TransactionOutput[];
  feeSats: Sats;
  stateHash: string;
  expiresAtHeight: bigint;
  expiresAtTimestamp: string;
  summary: TransactionSummary;
}
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}
export interface BuildDeployInput {
  ticker: string;
  name: string;
  creatorAddress: string;
  treasuryAddress: string;
  launchFeeSats: Sats;
  network: Network;
}
export interface BuildMintInput {
  deploymentId: TxId;
  ticker: string;
  buyerAddress: string;
  treasuryAddress: string;
  tokenAmountAtoms: DisplayTokens;
  curveContributionSats: Sats;
  platformFeeSats: Sats;
  minerFeeSats: Sats;
  currentSupplyAtoms: DisplayTokens;
  stateHash: string;
}
export interface BuildSellInput {
  deploymentId: TxId;
  sellerAddress: string;
  tokenAmountAtoms: DisplayTokens;
  askingPriceSats: Sats;
  expiryHeight: bigint;
}
export interface BuildBuyInput {
  deploymentId: TxId;
  listingId: string;
  buyerAddress: string;
  tokenAmountAtoms: DisplayTokens;
  totalPriceSats: Sats;
  sellerAddress: string;
  protocolFeeSats: Sats;
  platformFeeSats: Sats;
  minerFeeSats: Sats;
  treasuryAddress: string;
}
export interface BuildCancelInput {
  deploymentId: TxId;
  listingId: string;
  sellerAddress: string;
}
export interface DecodedProtocolTransaction {
  operation: ProtocolOperation;
  inputs: TransactionInput[];
  outputs: TransactionOutput[];
  ticker?: string;
  tokenAmountAtoms?: DisplayTokens;
}
export interface DecodedSignedTransaction {
  operation: ProtocolOperation;
  txid: string;
  signer: string | null;
}
export interface VerificationStatus {
  deploy: OperationStatus;
  mint: OperationStatus;
  transfer: OperationStatus;
  dexAsk: OperationStatus;
  dexBid: OperationStatus;
  cancel: OperationStatus;
  graduation: OperationStatus;
}
export interface ProtocolListing {
  id: string;
  deploymentId: string;
  sellerAddress: string;
  tokenAmountAtoms: DisplayTokens;
  askingPriceSats: Sats;
  creationHeight: bigint;
  expiryHeight: bigint;
  status: "OPEN" | "TAKEN" | "CANCELLED" | "EXPIRED";
}
export interface FeeBreakdown {
  protocolFeeSats: Sats;
  platformFeeSats: Sats;
  sellerReceivesSats: Sats;
  minerFeeSats: Sats;
  buyerPaysSats: Sats;
}
