import type { Sats, DisplayTokens } from "./types.js";
import {
  PRICE_UNIT_TOKENS,
  PUBLIC_SUPPLY_TOKENS,
  TOKENS_PER_STAGE,
} from "./constants.js";
import { CurveError, getStageForSupply, getStagePrice } from "./prices.js";
import { ceilDiv } from "./fees.js";
export interface ExactTokensInput {
  desiredTokens: DisplayTokens;
  currentSupply: DisplayTokens;
}
export interface ExactSatsInput {
  availableSats: Sats;
  currentSupply: DisplayTokens;
}
export interface QuoteResult {
  tokens: DisplayTokens;
  curveContributionSats: Sats;
  startingStage: number;
  endingStage: number;
  supplyBefore: DisplayTokens;
  supplyAfter: DisplayTokens;
}
function assertSupply(supply: DisplayTokens): void {
  if (supply < 0n) {
    throw new CurveError("NEGATIVE_SUPPLY", "Supply cannot be negative.");
  }
  if (supply >= PUBLIC_SUPPLY_TOKENS) {
    throw new CurveError("MINT_SOLD_OUT", "Public mint is sold out.");
  }
}
export function quoteExactTokens(input: ExactTokensInput): QuoteResult {
  const { desiredTokens, currentSupply } = input;
  if (desiredTokens <= 0n) {
    throw new CurveError(
      "ZERO_QUANTITY",
      "Desired token quantity must be positive.",
    );
  }
  assertSupply(currentSupply);
  const remainingPublic = PUBLIC_SUPPLY_TOKENS - currentSupply;
  if (desiredTokens > remainingPublic) {
    throw new CurveError(
      "EXCEEDS_REMAINING_SUPPLY",
      `Requested ${desiredTokens} tokens but only ${remainingPublic} remain.`,
    );
  }
  const startingStage = getStageForSupply(currentSupply);
  let endingStage = startingStage;
  let supply = currentSupply;
  let remaining = desiredTokens;
  let totalSats = 0n;
  while (remaining > 0n) {
    const stage = getStageForSupply(supply);
    endingStage = stage;
    const stageEnd = BigInt(stage) * TOKENS_PER_STAGE;
    const remainingInStage = stageEnd - supply;
    const chunk = remaining < remainingInStage ? remaining : remainingInStage;
    const price = getStagePrice(stage);
    const cost = ceilDiv(chunk * price, PRICE_UNIT_TOKENS);
    totalSats += cost;
    supply += chunk;
    remaining -= chunk;
  }
  return {
    tokens: desiredTokens,
    curveContributionSats: totalSats,
    startingStage,
    endingStage,
    supplyBefore: currentSupply,
    supplyAfter: supply,
  };
}
export function quoteExactSats(input: ExactSatsInput): QuoteResult {
  const { availableSats, currentSupply } = input;
  if (availableSats <= 0n) {
    throw new CurveError("ZERO_QUANTITY", "Available sats must be positive.");
  }
  assertSupply(currentSupply);
  const startingStage = getStageForSupply(currentSupply);
  let endingStage = startingStage;
  let supply = currentSupply;
  let remainingSats = availableSats;
  let totalTokens = 0n;
  while (remainingSats > 0n && supply < PUBLIC_SUPPLY_TOKENS) {
    const stage = getStageForSupply(supply);
    endingStage = stage;
    const stageEnd = BigInt(stage) * TOKENS_PER_STAGE;
    const remainingInStage = stageEnd - supply;
    const price = getStagePrice(stage);
    const maxAffordableInStage = (remainingSats * PRICE_UNIT_TOKENS) / price;
    const chunk =
      maxAffordableInStage < remainingInStage
        ? maxAffordableInStage
        : remainingInStage;
    if (chunk === 0n) break;
    const cost = ceilDiv(chunk * price, PRICE_UNIT_TOKENS);
    totalTokens += chunk;
    supply += chunk;
    remainingSats -= cost;
  }
  return {
    tokens: totalTokens,
    curveContributionSats: availableSats - remainingSats,
    startingStage,
    endingStage,
    supplyBefore: currentSupply,
    supplyAfter: supply,
  };
}
