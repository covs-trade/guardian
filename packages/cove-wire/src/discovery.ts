import {
  COVE_PROTOCOL_ID,
  OP_DEPLOY,
  OP_MINT,
  OP_REDEEM,
  OP_TRANSFER,
  opName,
} from "./opcodes.js";
import { DATACARRIER_PAYLOAD_LIMIT } from "./opcodes.js";
import type { ParsedEnvelopeV2 } from "./codecV2.js";
import { canonicalTicker } from "./ticker.js";
const KEY_ORDER = ["p", "op", "tick", "amt"] as const;
export interface DiscoveryEnvelope {
  p: string;
  op: string;
  tick: string;
  amt?: string;
}
export class DiscoveryError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "DiscoveryError";
    this.code = code;
  }
}
export function serializeDiscovery(env: DiscoveryEnvelope): Buffer {
  const parts: string[] = [];
  for (const k of KEY_ORDER) {
    const v = env[k];
    if (v === undefined) continue;
    parts.push(`${JSON.stringify(k)}:${JSON.stringify(v)}`);
  }
  return Buffer.from(`{${parts.join(",")}}`, "utf8");
}
export function discoveryFor(binary: ParsedEnvelopeV2): DiscoveryEnvelope {
  const op = opName(binary.op);
  switch (binary.op) {
    case OP_DEPLOY:
      return { p: COVE_PROTOCOL_ID, op, tick: canonicalTicker(binary.ticker) };
    case OP_MINT:
      return {
        p: COVE_PROTOCOL_ID,
        op,
        tick: "",
        amt: binary.amount.toString(),
      };
    case OP_TRANSFER: {
      const total = binary.allocations.reduce((a, x) => a + x.amount, 0n);
      return { p: COVE_PROTOCOL_ID, op, tick: "", amt: total.toString() };
    }
    case OP_REDEEM:
      return {
        p: COVE_PROTOCOL_ID,
        op,
        tick: "",
        amt: binary.redeemAmount.toString(),
      };
    default: {
      const unreachable: never = binary;
      throw new DiscoveryError(
        "BAD_OPCODE",
        `cannot derive discovery envelope: ${String(unreachable)}`,
      );
    }
  }
}
export function encodeDiscovery(
  binary: ParsedEnvelopeV2,
  ticker?: string,
): Buffer {
  const env = discoveryFor(binary);
  if (ticker !== undefined && env.tick === "")
    env.tick = canonicalTicker(ticker);
  if (env.tick === "")
    delete (
      env as {
        tick?: string;
      }
    ).tick;
  const bytes = serializeDiscovery(env);
  if (bytes.length > DATACARRIER_PAYLOAD_LIMIT) {
    throw new DiscoveryError(
      "DISCOVERY_TOO_LARGE",
      `discovery envelope is ${bytes.length}B, limit ${DATACARRIER_PAYLOAD_LIMIT}B`,
    );
  }
  return bytes;
}
export function decodeDiscovery(payload: Buffer): DiscoveryEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return null;
  const o = parsed as Record<string, unknown>;
  if (o.p !== COVE_PROTOCOL_ID) return null;
  if (typeof o.op !== "string") return null;
  const env: DiscoveryEnvelope = {
    p: o.p,
    op: o.op,
    tick: typeof o.tick === "string" ? o.tick : "",
  };
  if (typeof o.amt === "string") env.amt = o.amt;
  if (env.tick === "")
    delete (
      env as {
        tick?: string;
      }
    ).tick;
  return env;
}
export function discoveryAgreesWithBinary(
  payload: Buffer,
  binary: ParsedEnvelopeV2,
  ticker?: string,
): boolean {
  let expected: Buffer;
  try {
    expected = encodeDiscovery(binary, ticker);
  } catch {
    return false;
  }
  return payload.equals(expected);
}
