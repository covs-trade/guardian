export const COVE_MAGIC = 0x434f5645n;
export const COVE_VERSION = 1;
export const OP_DEPLOY = 0x01;
export const OP_MINT = 0x02;
export const OP_TRANSFER = 0x03;
export const COVE_DEPLOY_LEN = 10;
export const COVE_MINT_LEN = 26;
export const COVE_TRANSFER_LEN = 18;
export type CoveOp = "deploy" | "mint" | "transfer";
export interface CoveDeploy {
  op: "deploy";
  tick: string;
}
export interface CoveMint {
  op: "mint";
  tick: string;
  amt: bigint;
  s: bigint;
}
export interface CoveTransfer {
  op: "transfer";
  tick: string;
  amt: bigint;
}
export type CoveEnvelope = CoveDeploy | CoveMint | CoveTransfer;
export interface CoveDecodeResult {
  ok: boolean;
  envelope?: CoveEnvelope;
  reason?: string;
}
const TICK_BYTES = /^[0-9A-Z]{4}$/;
export function isCoveMagic(data: Uint8Array): boolean {
  return (
    data.length >= 4 &&
    data[0] === 0x43 &&
    data[1] === 0x4f &&
    data[2] === 0x56 &&
    data[3] === 0x45
  );
}
const U64_MAX = (1n << 64n) - 1n;
function writeU64BE(out: Uint8Array, offset: number, value: bigint): void {
  if (value < 0n) throw new RangeError("uint64 value must be >= 0");
  if (value > U64_MAX) throw new RangeError("uint64 value must be <= 2^64-1");
  for (let i = 7; i >= 0; i--) {
    out[offset + 7 - i] = Number((value >> BigInt(i * 8)) & 0xffn);
  }
}
function readU64BE(data: Uint8Array, offset: number): bigint {
  let v = 0n;
  for (let i = 0; i < 8; i++) {
    v = (v << 8n) | BigInt(data[offset + i]!);
  }
  return v;
}
function readTicker(data: Uint8Array, offset: number): string {
  return String.fromCharCode(
    data[offset]!,
    data[offset + 1]!,
    data[offset + 2]!,
    data[offset + 3]!,
  );
}
function writeTicker(out: Uint8Array, offset: number, tick: string): void {
  for (let i = 0; i < 4; i++) out[offset + i] = tick.charCodeAt(i);
}
export function encodeCoveDeploy(tick: string): Uint8Array {
  const out = new Uint8Array(COVE_DEPLOY_LEN);
  out[0] = 0x43;
  out[1] = 0x4f;
  out[2] = 0x56;
  out[3] = 0x45;
  out[4] = COVE_VERSION;
  out[5] = OP_DEPLOY;
  writeTicker(out, 6, tick);
  return out;
}
export function encodeCoveMint(
  tick: string,
  amountAtoms: bigint,
  supplyBeforeAtoms: bigint,
): Uint8Array {
  const out = new Uint8Array(COVE_MINT_LEN);
  out[0] = 0x43;
  out[1] = 0x4f;
  out[2] = 0x56;
  out[3] = 0x45;
  out[4] = COVE_VERSION;
  out[5] = OP_MINT;
  writeTicker(out, 6, tick);
  writeU64BE(out, 10, amountAtoms);
  writeU64BE(out, 18, supplyBeforeAtoms);
  return out;
}
export function encodeCoveTransfer(
  tick: string,
  amountAtoms: bigint,
): Uint8Array {
  const out = new Uint8Array(COVE_TRANSFER_LEN);
  out[0] = 0x43;
  out[1] = 0x4f;
  out[2] = 0x56;
  out[3] = 0x45;
  out[4] = COVE_VERSION;
  out[5] = OP_TRANSFER;
  writeTicker(out, 6, tick);
  writeU64BE(out, 10, amountAtoms);
  return out;
}
export function decodeCoveEnvelope(data: Uint8Array): CoveDecodeResult {
  if (data.length < 4 || !isCoveMagic(data))
    return { ok: false, reason: "NOT_COVE" };
  if (data.length < 6) return { ok: false, reason: "TRUNCATED" };
  if (data[4] !== COVE_VERSION)
    return { ok: false, reason: "UNSUPPORTED_VERSION" };
  const opcode = data[5];
  if (opcode === OP_DEPLOY) {
    if (data.length !== COVE_DEPLOY_LEN)
      return { ok: false, reason: "BAD_LENGTH" };
    const tick = readTicker(data, 6);
    if (!TICK_BYTES.test(tick)) return { ok: false, reason: "INVALID_TICKER" };
    return { ok: true, envelope: { op: "deploy", tick } };
  }
  if (opcode === OP_MINT) {
    if (data.length !== COVE_MINT_LEN)
      return { ok: false, reason: "BAD_LENGTH" };
    const tick = readTicker(data, 6);
    if (!TICK_BYTES.test(tick)) return { ok: false, reason: "INVALID_TICKER" };
    const amt = readU64BE(data, 10);
    const s = readU64BE(data, 18);
    return { ok: true, envelope: { op: "mint", tick, amt, s } };
  }
  if (opcode === OP_TRANSFER) {
    if (data.length !== COVE_TRANSFER_LEN)
      return { ok: false, reason: "BAD_LENGTH" };
    const tick = readTicker(data, 6);
    if (!TICK_BYTES.test(tick)) return { ok: false, reason: "INVALID_TICKER" };
    const amt = readU64BE(data, 10);
    return { ok: true, envelope: { op: "transfer", tick, amt } };
  }
  return { ok: false, reason: "UNSUPPORTED_OPERATION" };
}
