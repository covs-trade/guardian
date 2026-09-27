import { createHash } from "node:crypto";
import {
  ATOMS_PER_TOKEN,
  PUBLIC_SUPPLY_ATOMS,
  getStageForSupply,
} from "@crclaunch/curve";
import type { Atoms, Sats } from "@crclaunch/curve";
export const COVE_STATE_V2_BYTES = 51;
export const COVE_STATE_V2_VERSION = 2;
export const COVE_STATE_V2_DOMAIN = "Cove/State/v2";
export interface CoveStateV2 {
  stateVersion: 2;
  policyVersion: number;
  tokenId: string;
  issuedPublicSupplyAtoms: Atoms;
  backingSats: Sats;
  curveStage: number;
}
function writeU64BE(buf: Uint8Array, offset: number, value: bigint): void {
  if (value < 0n || value > 0xffffffffffffffffn) {
    throw new Error("value does not fit in u64");
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  view.setBigUint64(offset, value, false);
}
function readU64BE(buf: Uint8Array, offset: number): bigint {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return view.getBigUint64(offset, false);
}
export function serializeStateV2(state: CoveStateV2): Uint8Array {
  if (state.stateVersion !== COVE_STATE_V2_VERSION) {
    throw new Error(`unsupported stateVersion ${state.stateVersion}`);
  }
  if (!/^[0-9a-f]{64}$/.test(state.tokenId)) {
    throw new Error("tokenId must be 64 hex chars");
  }
  if (/^0{64}$/.test(state.tokenId)) {
    throw new Error("tokenId must be nonzero");
  }
  if (
    state.issuedPublicSupplyAtoms < 0n ||
    state.issuedPublicSupplyAtoms > PUBLIC_SUPPLY_ATOMS
  ) {
    throw new Error("issuedPublicSupplyAtoms out of range");
  }
  if (state.backingSats < 0n || state.backingSats > 0xffffffffffffffffn) {
    throw new Error("backingSats out of range");
  }
  const out = new Uint8Array(COVE_STATE_V2_BYTES);
  out[0] = state.stateVersion;
  out[1] = state.policyVersion;
  out.set(Buffer.from(state.tokenId, "hex"), 2);
  writeU64BE(out, 34, state.issuedPublicSupplyAtoms);
  writeU64BE(out, 42, state.backingSats);
  out[50] = state.curveStage;
  return out;
}
export function deserializeStateV2(bytes: Uint8Array): CoveStateV2 {
  if (bytes.length !== COVE_STATE_V2_BYTES) {
    throw new Error(
      `expected ${COVE_STATE_V2_BYTES} bytes, got ${bytes.length}`,
    );
  }
  if (bytes[0] !== COVE_STATE_V2_VERSION) {
    throw new Error(`unsupported stateVersion ${bytes[0]}`);
  }
  return {
    stateVersion: 2,
    policyVersion: bytes[1]!,
    tokenId: Buffer.from(bytes.subarray(2, 34)).toString("hex"),
    issuedPublicSupplyAtoms: readU64BE(bytes, 34),
    backingSats: readU64BE(bytes, 42),
    curveStage: bytes[50]!,
  };
}
export function stateHashV2(state: CoveStateV2): string {
  const bytes = serializeStateV2(state);
  return createHash("sha256")
    .update(COVE_STATE_V2_DOMAIN, "utf8")
    .update(Buffer.from([0x00]))
    .update(Buffer.from(bytes))
    .digest("hex");
}
export function impliedStageV2(supplyAtoms: Atoms): number {
  return getStageForSupply(supplyAtoms / ATOMS_PER_TOKEN);
}
