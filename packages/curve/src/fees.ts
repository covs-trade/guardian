import type { Sats } from "./types.js";
export function ceilDiv(numerator: Sats, denominator: Sats): Sats {
  if (denominator === 0n) throw new Error("Division by zero.");
  if (numerator < 0n || denominator < 0n)
    throw new Error("ceilDiv requires non-negative inputs.");
  if (numerator === 0n) return 0n;
  return (numerator + denominator - 1n) / denominator;
}
export function computePlatformFee(
  curveContributionSats: Sats,
  feeBps: bigint,
): Sats {
  if (feeBps < 0n) throw new Error("feeBps must be non-negative.");
  if (curveContributionSats < 0n)
    throw new Error("curveContributionSats must be non-negative.");
  if (curveContributionSats === 0n || feeBps === 0n) return 0n;
  return ceilDiv(curveContributionSats * feeBps, 10000n);
}
export function getMinimumContribution(estimatedMinerFeeSats: Sats): Sats {
  const floor = 1000n;
  const dynamic = estimatedMinerFeeSats * 5n;
  return dynamic > floor ? dynamic : floor;
}
