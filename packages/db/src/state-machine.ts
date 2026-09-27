import type { ListingStatus, TokenStatus, TxStatus } from "./status.js";
import { LISTING_STATUS, TOKEN_STATUS, TX_STATUS } from "./status.js";
export class InvalidTransitionError extends Error {
  constructor(from: string, to: string, machine: string) {
    super(`Invalid ${machine} transition: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}
const TX_TRANSITIONS: Record<TxStatus, readonly TxStatus[]> = {
  CREATED: [TX_STATUS.AWAITING_SIGNATURE, TX_STATUS.REJECTED, TX_STATUS.FAILED],
  AWAITING_SIGNATURE: [TX_STATUS.SIGNED, TX_STATUS.REJECTED, TX_STATUS.FAILED],
  SIGNED: [TX_STATUS.BROADCAST, TX_STATUS.REJECTED, TX_STATUS.FAILED],
  BROADCAST: [
    TX_STATUS.MEMPOOL,
    TX_STATUS.REJECTED,
    TX_STATUS.DROPPED,
    TX_STATUS.FAILED,
  ],
  MEMPOOL: [
    TX_STATUS.CONFIRMED,
    TX_STATUS.DROPPED,
    TX_STATUS.REPLACED,
    TX_STATUS.REJECTED,
  ],
  CONFIRMED: [TX_STATUS.INDEXED, TX_STATUS.REORGED, TX_STATUS.INVALID],
  INDEXED: [TX_STATUS.FINALIZED, TX_STATUS.REORGED],
  FINALIZED: [TX_STATUS.REORGED],
  REJECTED: [],
  DROPPED: [],
  REPLACED: [],
  INVALID: [],
  REORGED: [TX_STATUS.MEMPOOL, TX_STATUS.CONFIRMED],
  FAILED: [],
};
const TOKEN_TRANSITIONS: Record<TokenStatus, readonly TokenStatus[]> = {
  DRAFT: [TOKEN_STATUS.DEPLOY_AWAITING_SIGNATURE, TOKEN_STATUS.FAILED],
  DEPLOY_AWAITING_SIGNATURE: [
    TOKEN_STATUS.DEPLOY_BROADCAST,
    TOKEN_STATUS.DRAFT,
    TOKEN_STATUS.FAILED,
  ],
  DEPLOY_BROADCAST: [TOKEN_STATUS.DEPLOY_PENDING, TOKEN_STATUS.FAILED],
  DEPLOY_PENDING: [
    TOKEN_STATUS.LIVE,
    TOKEN_STATUS.FAILED,
    TOKEN_STATUS.REORG_RECOVERY,
  ],
  LIVE: [
    TOKEN_STATUS.SOLD_OUT,
    TOKEN_STATUS.PAUSED,
    TOKEN_STATUS.REORG_RECOVERY,
  ],
  PAUSED: [TOKEN_STATUS.LIVE],
  SOLD_OUT: [TOKEN_STATUS.GRADUATING, TOKEN_STATUS.REORG_RECOVERY],
  GRADUATING: [
    TOKEN_STATUS.GRADUATED,
    TOKEN_STATUS.LIVE,
    TOKEN_STATUS.REORG_RECOVERY,
  ],
  GRADUATED: [TOKEN_STATUS.REORG_RECOVERY],
  REORG_RECOVERY: [
    TOKEN_STATUS.LIVE,
    TOKEN_STATUS.SOLD_OUT,
    TOKEN_STATUS.GRADUATING,
    TOKEN_STATUS.GRADUATED,
  ],
  FAILED: [],
};
const LISTING_TRANSITIONS: Record<ListingStatus, readonly ListingStatus[]> = {
  BUILDING: [LISTING_STATUS.AWAITING_SIGNATURE, LISTING_STATUS.INVALID],
  AWAITING_SIGNATURE: [LISTING_STATUS.BROADCAST, LISTING_STATUS.INVALID],
  BROADCAST: [
    LISTING_STATUS.OPEN,
    LISTING_STATUS.INVALID,
    LISTING_STATUS.REORGED,
  ],
  OPEN: [
    LISTING_STATUS.TAKE_PENDING,
    LISTING_STATUS.CANCEL_PENDING,
    LISTING_STATUS.EXPIRED,
    LISTING_STATUS.REORGED,
  ],
  TAKE_PENDING: [
    LISTING_STATUS.TAKEN,
    LISTING_STATUS.OPEN,
    LISTING_STATUS.REORGED,
  ],
  TAKEN: [LISTING_STATUS.REORGED],
  CANCEL_PENDING: [
    LISTING_STATUS.CANCELLED,
    LISTING_STATUS.OPEN,
    LISTING_STATUS.REORGED,
  ],
  CANCELLED: [],
  EXPIRED: [],
  INVALID: [],
  REORGED: [LISTING_STATUS.OPEN],
};
export function assertTxTransition(from: TxStatus, to: TxStatus): void {
  if (!TX_TRANSITIONS[from].includes(to))
    throw new InvalidTransitionError(from, to, "tx");
}
export function assertTokenTransition(
  from: TokenStatus,
  to: TokenStatus,
): void {
  if (!TOKEN_TRANSITIONS[from].includes(to))
    throw new InvalidTransitionError(from, to, "token");
}
export function assertListingTransition(
  from: ListingStatus,
  to: ListingStatus,
): void {
  if (!LISTING_TRANSITIONS[from].includes(to))
    throw new InvalidTransitionError(from, to, "listing");
}
export function canTransition(from: TokenStatus, to: TokenStatus): boolean {
  return TOKEN_TRANSITIONS[from].includes(to);
}
