import {
  COVE_WIRE_MAGIC,
  DATACARRIER_PAYLOAD_LIMIT,
  OP_DEPLOY,
  OP_MINT,
  OP_REDEEM,
  OP_TRANSFER,
} from "./opcodes.js";
import { canonicalTicker } from "./ticker.js";
export {
  COVE_WIRE_MAGIC,
  OP_DEPLOY,
  OP_MINT,
  OP_REDEEM,
  OP_TRANSFER,
  canonicalTicker,
};
export const COVE_WIRE_V2 = 2;
export const MAX_TRANSFER_ALLOCATIONS = 4;
export const MAX_REDEEM_ALLOCATIONS = 3;
export interface TokenAllocation {
  vout: number;
  amount: bigint;
}
export type ParsedEnvelopeV2 =
  | {
      version: 2;
      op: typeof OP_DEPLOY;
      policyVersion: number;
      ticker: string;
      tokenNonce: Buffer;
    }
  | {
      version: 2;
      op: typeof OP_MINT;
      tokenId: Buffer;
      amount: bigint;
      recipientVout: number;
    }
  | {
      version: 2;
      op: typeof OP_TRANSFER;
      tokenId: Buffer;
      allocations: TokenAllocation[];
    }
  | {
      version: 2;
      op: typeof OP_REDEEM;
      tokenId: Buffer;
      redeemAmount: bigint;
      changeAllocations: TokenAllocation[];
    };
export class WireV2Error extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "WireV2Error";
    this.code = code;
  }
}
function headerV2(op: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt16BE(COVE_WIRE_MAGIC, 0);
  b[2] = COVE_WIRE_V2;
  b[3] = op;
  return b;
}
function tokenIdBuffer(tokenId: Buffer): Buffer {
  if (tokenId.length !== 32)
    throw new WireV2Error("INVALID_TOKEN_ID", "tokenId must be 32 bytes");
  if (tokenId.equals(Buffer.alloc(32)))
    throw new WireV2Error("INVALID_TOKEN_ID", "tokenId must be nonzero");
  return Buffer.from(tokenId);
}
function amountBuf(amount: bigint): Buffer {
  if (amount <= 0n)
    throw new WireV2Error("ZERO_AMOUNT", "amount must be positive");
  if (amount > 0xffffffffffffffffn)
    throw new WireV2Error("AMOUNT_OVERFLOW", "amount exceeds u64");
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(amount, 0);
  return b;
}
function voutBuf(vout: number): Buffer {
  if (!Number.isInteger(vout) || vout < 0 || vout > 255) {
    throw new WireV2Error("INVALID_VOUT", "vout out of range");
  }
  return Buffer.from([vout]);
}
function assertAllocations(
  allocations: TokenAllocation[],
  max: number,
  min: number,
): void {
  if (allocations.length < min)
    throw new WireV2Error(
      "ZERO_ALLOCATIONS",
      `at least ${min} allocations required`,
    );
  if (allocations.length > max)
    throw new WireV2Error("TOO_MANY_ALLOCATIONS", `max ${max} allocations`);
  const seen = new Set<number>();
  let total = 0n;
  for (const a of allocations) {
    if (seen.has(a.vout))
      throw new WireV2Error("DUPLICATE_VOUT", `duplicate vout ${a.vout}`);
    seen.add(a.vout);
    if (a.amount <= 0n)
      throw new WireV2Error(
        "ZERO_AMOUNT",
        "allocation amount must be positive",
      );
    total += a.amount;
    if (total > 0xffffffffffffffffn)
      throw new WireV2Error(
        "AMOUNT_OVERFLOW",
        "allocation total overflows u64",
      );
  }
}
export function encodeDeployV2(params: {
  policyVersion: number;
  ticker: string;
  tokenNonce: Buffer;
}): Buffer {
  if (params.policyVersion !== 3)
    throw new WireV2Error("BAD_POLICY_VERSION", "policyVersion must be 3");
  if (params.tokenNonce.length !== 32)
    throw new WireV2Error("INVALID_NONCE", "nonce must be 32 bytes");
  const tick = canonicalTicker(params.ticker);
  const tickBuf = Buffer.from(tick, "utf8");
  return Buffer.concat([
    headerV2(OP_DEPLOY),
    Buffer.from([params.policyVersion, tickBuf.length]),
    tickBuf,
    params.tokenNonce,
  ]);
}
export function encodeMintV2(params: {
  tokenId: Buffer;
  amount: bigint;
  recipientVout: number;
}): Buffer {
  return Buffer.concat([
    headerV2(OP_MINT),
    tokenIdBuffer(params.tokenId),
    amountBuf(params.amount),
    voutBuf(params.recipientVout),
  ]);
}
export function encodeTransferV2(params: {
  tokenId: Buffer;
  allocations: TokenAllocation[];
}): Buffer {
  assertAllocations(params.allocations, MAX_TRANSFER_ALLOCATIONS, 1);
  const parts: Buffer[] = [
    headerV2(OP_TRANSFER),
    tokenIdBuffer(params.tokenId),
    Buffer.from([params.allocations.length]),
  ];
  for (const a of params.allocations)
    parts.push(voutBuf(a.vout), amountBuf(a.amount));
  return Buffer.concat(parts);
}
export function encodeRedeemV2(params: {
  tokenId: Buffer;
  redeemAmount: bigint;
  changeAllocations: TokenAllocation[];
}): Buffer {
  assertAllocations(params.changeAllocations, MAX_REDEEM_ALLOCATIONS, 0);
  const parts: Buffer[] = [
    headerV2(OP_REDEEM),
    tokenIdBuffer(params.tokenId),
    amountBuf(params.redeemAmount),
    Buffer.from([params.changeAllocations.length]),
  ];
  for (const a of params.changeAllocations)
    parts.push(voutBuf(a.vout), amountBuf(a.amount));
  return Buffer.concat(parts);
}
function readHeaderV2(payload: Buffer): {
  op: number;
} {
  if (payload.length < 4)
    throw new WireV2Error("TRUNCATED", "payload shorter than header");
  if (payload.readUInt16BE(0) !== COVE_WIRE_MAGIC)
    throw new WireV2Error("BAD_MAGIC", "bad magic");
  if (payload[2] !== COVE_WIRE_V2)
    throw new WireV2Error("BAD_VERSION", `expected v2, got ${payload[2]}`);
  return { op: payload[3]! };
}
function assertCanonicalTokenId(tokenId: Buffer): void {
  if (tokenId.length !== 32)
    throw new WireV2Error("INVALID_TOKEN_ID", "tokenId must be 32 bytes");
  if (tokenId.equals(Buffer.alloc(32)))
    throw new WireV2Error("INVALID_TOKEN_ID", "zero tokenId");
}
function assertCanonicalTicker(ticker: string): void {
  if (ticker !== canonicalTicker(ticker)) {
    throw new WireV2Error(
      "NONCANONICAL_TICKER",
      "ticker is not canonical uppercase",
    );
  }
}
function readTokenId(payload: Buffer, offset: number): Buffer {
  const tokenId = Buffer.from(payload.subarray(offset, offset + 32));
  assertCanonicalTokenId(tokenId);
  return tokenId;
}
function readAmount(payload: Buffer, offset: number): bigint {
  return payload.readBigUInt64BE(offset);
}
function readAllocations(
  payload: Buffer,
  offset: number,
  count: number,
  max: number,
): TokenAllocation[] {
  if (count > max)
    throw new WireV2Error("TOO_MANY_ALLOCATIONS", "too many allocations");
  const out: TokenAllocation[] = [];
  const seen = new Set<number>();
  let total = 0n;
  for (let i = 0; i < count; i++) {
    const vout = payload[offset + i * 9]!;
    const amount = readAmount(payload, offset + i * 9 + 1);
    if (amount === 0n)
      throw new WireV2Error("ZERO_AMOUNT", "zero allocation amount");
    if (seen.has(vout))
      throw new WireV2Error("DUPLICATE_VOUT", "duplicate vout");
    seen.add(vout);
    total += amount;
    if (total > 0xffffffffffffffffn)
      throw new WireV2Error("AMOUNT_OVERFLOW", "allocation sum overflows u64");
    out.push({ vout, amount });
  }
  return out;
}
export function decodeV2(payload: Buffer): ParsedEnvelopeV2 {
  const { op } = readHeaderV2(payload);
  switch (op) {
    case OP_DEPLOY: {
      if (payload.length < 6)
        throw new WireV2Error("TRUNCATED", "deploy too short");
      const policyVersion = payload[4]!;
      if (policyVersion !== 3)
        throw new WireV2Error("BAD_POLICY_VERSION", "policyVersion must be 3");
      const tickLen = payload[5]!;
      if (tickLen === 0 || tickLen > 16)
        throw new WireV2Error(
          "NONCANONICAL_TICKER",
          "ticker length out of range",
        );
      if (payload.length !== 6 + tickLen + 32)
        throw new WireV2Error("TRUNCATED", "deploy length mismatch");
      const ticker = payload.subarray(6, 6 + tickLen).toString("utf8");
      assertCanonicalTicker(ticker);
      const tokenNonce = Buffer.from(
        payload.subarray(6 + tickLen, 6 + tickLen + 32),
      );
      return { version: 2, op, policyVersion, ticker, tokenNonce };
    }
    case OP_MINT: {
      if (payload.length !== 4 + 32 + 8 + 1)
        throw new WireV2Error("TRUNCATED", "mint length mismatch");
      const tokenId = readTokenId(payload, 4);
      const amount = readAmount(payload, 36);
      if (amount === 0n)
        throw new WireV2Error("ZERO_AMOUNT", "zero mint amount");
      return { version: 2, op, tokenId, amount, recipientVout: payload[44]! };
    }
    case OP_TRANSFER: {
      if (payload.length < 4 + 32 + 1)
        throw new WireV2Error("TRUNCATED", "transfer too short");
      const tokenId = readTokenId(payload, 4);
      const count = payload[36]!;
      if (count === 0)
        throw new WireV2Error("ZERO_ALLOCATIONS", "zero allocations");
      const expected = 4 + 32 + 1 + count * 9;
      if (payload.length !== expected)
        throw new WireV2Error("TRUNCATED", "transfer length mismatch");
      const allocations = readAllocations(
        payload,
        37,
        count,
        MAX_TRANSFER_ALLOCATIONS,
      );
      return { version: 2, op, tokenId, allocations };
    }
    case OP_REDEEM: {
      if (payload.length < 4 + 32 + 8 + 1)
        throw new WireV2Error("TRUNCATED", "redeem too short");
      const tokenId = readTokenId(payload, 4);
      const redeemAmount = readAmount(payload, 36);
      if (redeemAmount === 0n)
        throw new WireV2Error("ZERO_AMOUNT", "zero redeem amount");
      const count = payload[44]!;
      const expected = 4 + 32 + 8 + 1 + count * 9;
      if (payload.length !== expected)
        throw new WireV2Error("TRUNCATED", "redeem length mismatch");
      const changeAllocations = readAllocations(
        payload,
        45,
        count,
        MAX_REDEEM_ALLOCATIONS,
      );
      return { version: 2, op, tokenId, redeemAmount, changeAllocations };
    }
    default:
      throw new WireV2Error("BAD_OPCODE", `unknown op 0x${op.toString(16)}`);
  }
}
export function withinDatacarrier(payload: Buffer): boolean {
  return payload.length <= DATACARRIER_PAYLOAD_LIMIT;
}
export function reencodeV2(e: ParsedEnvelopeV2): Buffer {
  switch (e.op) {
    case OP_DEPLOY:
      return encodeDeployV2({
        policyVersion: e.policyVersion,
        ticker: e.ticker,
        tokenNonce: e.tokenNonce,
      });
    case OP_MINT:
      return encodeMintV2({
        tokenId: e.tokenId,
        amount: e.amount,
        recipientVout: e.recipientVout,
      });
    case OP_TRANSFER:
      return encodeTransferV2({
        tokenId: e.tokenId,
        allocations: e.allocations,
      });
    case OP_REDEEM:
      return encodeRedeemV2({
        tokenId: e.tokenId,
        redeemAmount: e.redeemAmount,
        changeAllocations: e.changeAllocations,
      });
  }
}
