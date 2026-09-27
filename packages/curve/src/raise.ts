import type { Sats, DisplayTokens } from "./types.js";
import {
  GRADUATION_RESERVE_TOKENS,
  PUBLIC_SUPPLY_TOKENS,
  STAGE_PRICES_SATS_PER_MILLION,
  STAGE_COUNT,
  TOTAL_SUPPLY_TOKENS,
  TOKENS_PER_STAGE,
} from "./constants.js";
const FIRST_PRICE = STAGE_PRICES_SATS_PER_MILLION[0]!;
const LAST_PRICE = STAGE_PRICES_SATS_PER_MILLION[STAGE_COUNT - 1]!;
export function getTheoreticalFullRaise(): Sats {
  let total = 0n;
  for (const price of STAGE_PRICES_SATS_PER_MILLION) {
    total += (TOKENS_PER_STAGE * price) / 1000000n;
  }
  return total;
}
export interface CurveConfigInput {
  totalSupplyTokens?: DisplayTokens;
  publicSupplyTokens?: DisplayTokens;
  reserveSupplyTokens?: DisplayTokens;
  tokensPerStage?: DisplayTokens;
  stagePrices?: readonly Sats[];
}
export const FULL_RAISE_SATS: Sats = STAGE_PRICES_SATS_PER_MILLION.reduce(
  (acc, p) => acc + (TOKENS_PER_STAGE * p) / 1000000n,
  0n,
);
export function validateCurveConfig(input: CurveConfigInput = {}): string[] {
  const total = input.totalSupplyTokens ?? TOTAL_SUPPLY_TOKENS;
  const publicSupply = input.publicSupplyTokens ?? PUBLIC_SUPPLY_TOKENS;
  const reserve = input.reserveSupplyTokens ?? GRADUATION_RESERVE_TOKENS;
  const tokensPerStage = input.tokensPerStage ?? TOKENS_PER_STAGE;
  const prices = input.stagePrices ?? STAGE_PRICES_SATS_PER_MILLION;
  const problems: string[] = [];
  if (total !== TOTAL_SUPPLY_TOKENS)
    problems.push(`TOTAL_SUPPLY_TOKENS must be ${TOTAL_SUPPLY_TOKENS}.`);
  if (publicSupply + reserve !== total) {
    problems.push("public + reserve must equal total supply.");
  }
  if (prices.length !== STAGE_COUNT) {
    problems.push(`Must be exactly ${STAGE_COUNT} stages.`);
  }
  if (prices[0] !== FIRST_PRICE) {
    problems.push(`Stage 1 price must be ${FIRST_PRICE}.`);
  }
  if (prices[STAGE_COUNT - 1] !== LAST_PRICE) {
    problems.push(`Stage ${STAGE_COUNT} price must be ${LAST_PRICE}.`);
  }
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1]!;
    const cur = prices[i]!;
    if (cur <= prev)
      problems.push(`Stage ${i + 1} price must exceed stage ${i} price.`);
  }
  const fullRaise = prices.reduce(
    (acc, p) => acc + (tokensPerStage * p) / 1000000n,
    0n,
  );
  if (fullRaise !== FULL_RAISE_SATS) {
    problems.push(
      `Full raise must be ${FULL_RAISE_SATS} sats (got ${fullRaise}).`,
    );
  }
  return problems;
}
export function getPublicMintProgress(supply: DisplayTokens): {
  mintedTokens: DisplayTokens;
  totalTokens: DisplayTokens;
  bps: number;
} {
  const clamped =
    supply < 0n
      ? 0n
      : supply > PUBLIC_SUPPLY_TOKENS
        ? PUBLIC_SUPPLY_TOKENS
        : supply;
  const bps = Number((clamped * 10000n) / PUBLIC_SUPPLY_TOKENS);
  return { mintedTokens: clamped, totalTokens: PUBLIC_SUPPLY_TOKENS, bps };
}
export function getRemainingPublicSupply(supply: DisplayTokens): DisplayTokens {
  const remaining = PUBLIC_SUPPLY_TOKENS - supply;
  return remaining < 0n ? 0n : remaining;
}
