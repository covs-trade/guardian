import type { ProtocolOperation } from "./types.js";
export type ProtocolErrorCode =
  | "PROTOCOL_NOT_VERIFIED"
  | "PROTOCOL_UNAVAILABLE"
  | "TICKER_TAKEN"
  | "SUPPLY_CHANGED"
  | "MINT_SOLD_OUT"
  | "QUOTE_EXPIRED"
  | "LISTING_ALREADY_TAKEN"
  | "LISTING_EXPIRED"
  | "TX_REJECTED"
  | "TX_DROPPED"
  | "NETWORK_MISMATCH"
  | "INVARIANT_VIOLATION"
  | "INSUFFICIENT_BTC"
  | "UNSUPPORTED_OPERATION";
export class ProtocolError extends Error {
  readonly code: ProtocolErrorCode;
  readonly retryable: boolean;
  readonly operation?: ProtocolOperation;
  constructor(
    code: ProtocolErrorCode,
    message: string,
    opts: {
      retryable?: boolean;
      operation?: ProtocolOperation;
    } = {},
  ) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.operation = opts.operation;
  }
}
export function isProtocolError(e: unknown): e is ProtocolError {
  return e instanceof ProtocolError;
}
