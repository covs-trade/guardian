import type { DisplayTokens, Sats } from "@crclaunch/curve";
import {
  PUBLIC_SUPPLY_TOKENS,
  STAGE_PRICES_SATS_PER_MILLION,
  TOKENS_PER_STAGE as STAIR_TOKENS,
} from "@crclaunch/curve";
export const PUBLIC_SUPPLY = PUBLIC_SUPPLY_TOKENS;
export const TOTAL_SUPPLY = PUBLIC_SUPPLY_TOKENS;
export const RESERVED = 0n;
export const PRICE_UNIT = 1000000n;
export interface Curve {
  id: string;
  name: string;
  complexity: string;
  priceAt(supply: DisplayTokens): Sats;
  costToBuy(supply: DisplayTokens, amount: DisplayTokens): Sats;
}
function ceilDiv(n: bigint, d: bigint): bigint {
  if (d === 0n) throw new Error("division by zero");
  if (n <= 0n) return 0n;
  return (n + d - 1n) / d;
}
function sumRange(a: bigint, b: bigint): bigint {
  const n = b - a + 1n;
  return ((a + b) * n) / 2n;
}
const STAGE_PRICES: readonly bigint[] = STAGE_PRICES_SATS_PER_MILLION;
const TOKENS_PER_STAGE = STAIR_TOKENS;
function stageAt(supply: DisplayTokens): number {
  if (supply >= PUBLIC_SUPPLY) return STAGE_PRICES.length - 1;
  return Number(supply / TOKENS_PER_STAGE);
}
export const stairs210: Curve = {
  id: "stairs210",
  name: "210 even stairs of 100,000 tokens",
  complexity: "stair index lookup + per-chunk ceilDiv (multiply + divide)",
  priceAt(supply) {
    return STAGE_PRICES[stageAt(supply)]!;
  },
  costToBuy(supply, amount) {
    let remaining = amount;
    let s = supply;
    let cost = 0n;
    while (remaining > 0n) {
      const stage = stageAt(s);
      const stageEnd = (BigInt(stage) + 1n) * TOKENS_PER_STAGE;
      const inStage = stageEnd - s;
      const chunk = remaining < inStage ? remaining : inStage;
      if (chunk <= 0n)
        throw new Error(
          `cannot price ${amount} tokens from ${supply}: beyond the public supply`,
        );
      cost += ceilDiv(chunk * STAGE_PRICES[stage]!, PRICE_UNIT);
      s += chunk;
      remaining -= chunk;
    }
    return cost;
  },
};
const P0 = 500n;
const P1 = 150000n;
const RAMP = P1 - P0;
export const linearRamp: Curve = {
  id: "linear",
  name: "piecewise-linear ramp (500 → 150k sats/M)",
  complexity:
    "one multiply_64 + add + one constant division (128-bit); very Simplicity-friendly",
  priceAt(supply) {
    const capped = supply > PUBLIC_SUPPLY ? PUBLIC_SUPPLY : supply;
    return P0 + (RAMP * capped) / PUBLIC_SUPPLY;
  },
  costToBuy(supply, amount) {
    const n = amount;
    const s = supply;
    const num = P0 * n * 2n * PUBLIC_SUPPLY + RAMP * (n * n + 2n * s * n);
    const den = 2n * PUBLIC_SUPPLY * PRICE_UNIT;
    return ceilDiv(num, den);
  },
};
const QK = RAMP;
export const quadratic: Curve = {
  id: "quadratic",
  name: "quadratic convex (500 → 150k sats/M)",
  complexity:
    "multiply_64 (square) + multiply_64 + add; 3 multiplies + divide; feasible but heavier",
  priceAt(supply) {
    const capped = supply > PUBLIC_SUPPLY ? PUBLIC_SUPPLY : supply;
    return P0 + (QK * capped * capped) / (PUBLIC_SUPPLY * PUBLIC_SUPPLY);
  },
  costToBuy(supply, amount) {
    const n = amount;
    const s = supply;
    const sCube = s * s * s;
    const eCube = (s + n) * (s + n) * (s + n);
    const num =
      P0 * n * 3n * PUBLIC_SUPPLY * PUBLIC_SUPPLY + QK * (eCube - sCube);
    const den = 3n * PUBLIC_SUPPLY * PUBLIC_SUPPLY * PRICE_UNIT;
    return ceilDiv(num, den);
  },
};
const KINK = PUBLIC_SUPPLY / 2n;
const SEG0_START = 500n;
const SEG0_END = 20000n;
const SEG1_START = 20000n;
const SEG1_END = 150000n;
function twoSegPriceAt(supply: DisplayTokens): Sats {
  if (supply <= KINK) {
    return SEG0_START + ((SEG0_END - SEG0_START) * supply) / KINK;
  }
  const beyond = supply - KINK;
  return (
    SEG1_START + ((SEG1_END - SEG1_START) * beyond) / (PUBLIC_SUPPLY - KINK)
  );
}
export const twoSegmentLinear: Curve = {
  id: "twoSegLinear",
  name: "two-segment linear (kink at 50%)",
  complexity:
    "branch on supply vs kink + one multiply_64 + divide; Simplicity-friendly",
  priceAt: twoSegPriceAt,
  costToBuy(supply, amount) {
    const end = supply + amount;
    let cost = 0n;
    const s0 = supply < KINK ? supply : KINK;
    const e0 = end < KINK ? end : KINK;
    if (e0 > s0) {
      const n = e0 - s0;
      const m = SEG0_END - SEG0_START;
      const num = SEG0_START * n * 2n * KINK + m * (n * n + 2n * s0 * n);
      cost += ceilDiv(num, 2n * KINK * PRICE_UNIT);
    }
    if (end > KINK) {
      const s1 = supply < KINK ? KINK : supply;
      const n = end - s1;
      const m = SEG1_END - SEG1_START;
      const segLen = PUBLIC_SUPPLY - KINK;
      const beyond = s1 - KINK;
      const num = SEG1_START * n * 2n * segLen + m * (n * n + 2n * beyond * n);
      cost += ceilDiv(num, 2n * segLen * PRICE_UNIT);
    }
    return cost;
  },
};
export const CURVES: Curve[] = [
  stairs210,
  linearRamp,
  quadratic,
  twoSegmentLinear,
];
export { sumRange };
