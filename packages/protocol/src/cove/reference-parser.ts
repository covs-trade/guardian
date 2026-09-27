import {
  COVE_DEPLOY_LEN,
  COVE_MINT_LEN,
  COVE_TRANSFER_LEN,
  OP_DEPLOY,
  OP_MINT,
  OP_TRANSFER,
} from "./envelope.js";
export interface RefResult {
  ok: boolean;
  op?: "deploy" | "mint" | "transfer";
  tick?: string;
  amt?: bigint;
  s?: bigint;
  reason?: string;
}
function tickOf(data: Uint8Array, off: number): string | null {
  let s = "";
  for (let i = 0; i < 4; i++) {
    const c = data[off + i]!;
    const isDigit = c >= 0x30 && c <= 0x39;
    const isUpper = c >= 0x41 && c <= 0x5a;
    if (!isDigit && !isUpper) return null;
    s += String.fromCharCode(c);
  }
  return s;
}
function magicOk(data: Uint8Array): boolean {
  return (
    data.length >= 4 &&
    data[0] === 0x43 &&
    data[1] === 0x4f &&
    data[2] === 0x56 &&
    data[3] === 0x45
  );
}
export function decodeCoveEnvelopeReference(data: Uint8Array): RefResult {
  if (!magicOk(data)) return { ok: false, reason: "NOT_COVE" };
  if (data.length < 6) return { ok: false, reason: "TRUNCATED" };
  if (data[4] !== 1) return { ok: false, reason: "UNSUPPORTED_VERSION" };
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const opcode = data[5];
  if (opcode === OP_DEPLOY) {
    if (data.length !== COVE_DEPLOY_LEN)
      return { ok: false, reason: "BAD_LENGTH" };
    const tick = tickOf(data, 6);
    if (!tick) return { ok: false, reason: "INVALID_TICKER" };
    return { ok: true, op: "deploy", tick };
  }
  if (opcode === OP_MINT) {
    if (data.length !== COVE_MINT_LEN)
      return { ok: false, reason: "BAD_LENGTH" };
    const tick = tickOf(data, 6);
    if (!tick) return { ok: false, reason: "INVALID_TICKER" };
    return {
      ok: true,
      op: "mint",
      tick,
      amt: view.getBigUint64(10, false),
      s: view.getBigUint64(18, false),
    };
  }
  if (opcode === OP_TRANSFER) {
    if (data.length !== COVE_TRANSFER_LEN)
      return { ok: false, reason: "BAD_LENGTH" };
    const tick = tickOf(data, 6);
    if (!tick) return { ok: false, reason: "INVALID_TICKER" };
    return {
      ok: true,
      op: "transfer",
      tick,
      amt: view.getBigUint64(10, false),
    };
  }
  return { ok: false, reason: "UNSUPPORTED_OPERATION" };
}
