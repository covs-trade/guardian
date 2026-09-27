import type { Buffer } from "node:buffer";
import {
  decodeDiscovery,
  discoveryAgreesWithBinary,
  type ParsedEnvelopeV2,
} from "@crclaunch/cove-wire";
export interface DiscoveryOutputCheck {
  present: boolean;
  agrees: boolean;
  allowance: number;
  reason?: string;
}
const OP_RETURN = 0x6a;
export function opReturnPayload(script: Buffer): Buffer | null {
  if (script.length < 2 || script[0] !== OP_RETURN) return null;
  const len = script[1]!;
  if (len > 0x4b || script.length !== 2 + len) return null;
  return script.subarray(2);
}
export function checkDiscoveryOutput(
  outputs: readonly {
    vout: number;
    script: Buffer;
    value: bigint;
  }[],
  binary: ParsedEnvelopeV2,
  ticker?: string,
): DiscoveryOutputCheck {
  const last = outputs[outputs.length - 1];
  if (!last || outputs.length < 2)
    return { present: false, agrees: false, allowance: 0 };
  const payload = opReturnPayload(last.script);
  if (!payload) return { present: false, agrees: false, allowance: 0 };
  const parsed = decodeDiscovery(payload);
  if (!parsed) return { present: false, agrees: false, allowance: 0 };
  if (last.value !== 0n) {
    return {
      present: true,
      agrees: false,
      allowance: 1,
      reason: `discovery output carries ${last.value} sats; must be 0`,
    };
  }
  if (!discoveryAgreesWithBinary(payload, binary, ticker)) {
    return {
      present: true,
      agrees: false,
      allowance: 1,
      reason: `discovery envelope contradicts the binary envelope: ${payload.toString("utf8").slice(0, 96)}`,
    };
  }
  return { present: true, agrees: true, allowance: 1 };
}
