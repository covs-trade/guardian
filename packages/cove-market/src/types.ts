export const MARKET_ORDER_VERSION = 1;
export const MARKET_CANCEL_VERSION = 1;
export interface ListingV1 {
  orderVersion: 1;
  chainIdentity: string;
  tokenId: string;
  sellerTokenScript: string;
  sellerPayoutScript: string;
  sellerTokenChangeScript: string;
  sourceTxid: string;
  sourceVout: number;
  sourceAmountAtoms: bigint;
  amountAtoms: bigint;
  totalPriceSats: bigint;
  creationHeight: bigint;
  expiryHeight: bigint;
  nonce: string;
}
export type ListingStatus =
  | "PENDING"
  | "ACTIVE"
  | "RESERVED"
  | "BROADCAST"
  | "FILLED"
  | "CANCELLED"
  | "EXPIRED"
  | "INVALIDATED"
  | "REORGED";
export type FillStatus =
  | "RESERVED"
  | "PSBT_BUILT"
  | "BUYER_SIGNED"
  | "BROADCAST"
  | "CONFIRMED"
  | "REORGED"
  | "FAILED"
  | "EXPIRED"
  | "CANCELLED";
export interface CancellationV1 {
  version: 1;
  listingId: string;
  cancelNonce: string;
}
