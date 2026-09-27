import type { Sats } from "@crclaunch/curve";
import type { TransactionOutput } from "../types.js";
export function outputsToAddress(
  outputs: readonly TransactionOutput[],
  address: string,
): Sats {
  return outputs
    .filter((o) => o.address === address)
    .reduce((acc, o) => acc + o.amountSats, 0n);
}
export function countOutputsToAddress(
  outputs: readonly TransactionOutput[],
  address: string,
): number {
  return outputs.filter((o) => o.address === address).length;
}
export function sumOutputsByKind(
  outputs: readonly TransactionOutput[],
  kind: string,
): Sats {
  return outputs
    .filter((o) => o.kind === kind)
    .reduce((acc, o) => acc + o.amountSats, 0n);
}
export function findOutputByKind(
  outputs: readonly TransactionOutput[],
  kind: string,
): TransactionOutput | undefined {
  return outputs.find((o) => o.kind === kind);
}
export function countOutputsByKind(
  outputs: readonly TransactionOutput[],
  kind: string,
): number {
  return outputs.filter((o) => o.kind === kind).length;
}
export interface ExpectedOutput {
  index: number;
  address: string;
  amountSats: Sats;
  kind: string;
}
export function validateExactOutputs(
  outputs: readonly TransactionOutput[],
  expected: readonly ExpectedOutput[],
): string | null {
  if (outputs.length !== expected.length) {
    return "INVALID_OUTPUT_LAYOUT";
  }
  for (let i = 0; i < expected.length; i++) {
    const exp = expected[i]!;
    const out = outputs[i]!;
    if (out.index !== exp.index) return "INVALID_OUTPUT_LAYOUT";
    if (out.address !== exp.address) return "WRONG_OUTPUT_ADDRESS";
    if (out.kind !== exp.kind) return "WRONG_OUTPUT_KIND";
    if (out.amountSats < exp.amountSats) return "UNDERPAYMENT";
    if (out.amountSats > exp.amountSats) return "OVERPAYMENT";
  }
  return null;
}
export interface OpValidationResult<T = unknown> {
  valid: boolean;
  reason: string | null;
  normalized: T | null;
}
export function ok<T>(normalized: T): OpValidationResult<T> {
  return { valid: true, reason: null, normalized };
}
export function invalid<T>(reason: string): OpValidationResult<T> {
  return { valid: false, reason, normalized: null };
}
