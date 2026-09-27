import { createHash } from "node:crypto";
import type { CoveState } from "./types.js";
import { byteToPhase, phaseToByte } from "./types.js";
export const COVE_STATE_BYTES = 51;
export const COVE_STATE_VERSION = 1;
export const STATE_DOMAIN = "Cove/State/v1";
function writeU64BE(buf: Uint8Array, offset: number, value: bigint): void {
  if (value < 0n || value > 0xffffffffffffffffn) {
    throw new Error(`value ${value} does not fit in u64`);
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  view.setBigUint64(offset, value, false);
}
function readU64BE(buf: Uint8Array, offset: number): bigint {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return view.getBigUint64(offset, false);
}
export function serializeState(state: CoveState): Uint8Array {
  if (state.version !== COVE_STATE_VERSION) {
    throw new Error(
      `Unsupported state version ${state.version} (expected ${COVE_STATE_VERSION})`,
    );
  }
  if (!/^[0-9a-f]{64}$/.test(state.tokenId)) {
    throw new Error(`tokenId must be 64 hex chars, got "${state.tokenId}"`);
  }
  if (
    state.publicSupplyAtoms < 0n ||
    state.publicSupplyAtoms > 0xffffffffffffffffn
  ) {
    throw new Error("publicSupplyAtoms does not fit in u64");
  }
  if (state.reserveSats < 0n || state.reserveSats > 0xffffffffffffffffn) {
    throw new Error("reserveSats does not fit in u64");
  }
  if (
    !Number.isInteger(state.curveStage) ||
    state.curveStage < 1 ||
    state.curveStage > 20
  ) {
    throw new Error(
      `curveStage must be an integer 1..20, got ${state.curveStage}`,
    );
  }
  const out = new Uint8Array(COVE_STATE_BYTES);
  out[0] = state.version;
  out.set(Buffer.from(state.tokenId, "hex"), 1);
  out[33] = phaseToByte(state.phase);
  writeU64BE(out, 34, state.publicSupplyAtoms);
  writeU64BE(out, 42, state.reserveSats);
  out[50] = state.curveStage;
  return out;
}
export function deserializeState(bytes: Uint8Array): CoveState {
  if (bytes.length !== COVE_STATE_BYTES) {
    throw new Error(`Expected ${COVE_STATE_BYTES} bytes, got ${bytes.length}`);
  }
  if (bytes[0] !== COVE_STATE_VERSION) {
    throw new Error(
      `Unsupported state version ${bytes[0]} (expected ${COVE_STATE_VERSION})`,
    );
  }
  return {
    version: bytes[0]!,
    tokenId: Buffer.from(bytes.subarray(1, 33)).toString("hex"),
    phase: byteToPhase(bytes[33]!),
    publicSupplyAtoms: readU64BE(bytes, 34),
    reserveSats: readU64BE(bytes, 42),
    curveStage: bytes[50]!,
  };
}
export function stateHash(state: CoveState): string {
  const bytes = serializeState(state);
  return createHash("sha256")
    .update(STATE_DOMAIN, "utf8")
    .update(Buffer.from([0x00]))
    .update(Buffer.from(bytes))
    .digest("hex");
}
