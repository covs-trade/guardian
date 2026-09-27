import type { Sats, DisplayTokens } from "./types.js";
import {
  PUBLIC_SUPPLY_TOKENS,
  STAGE_COUNT,
  STAGE_PRICES_SATS_PER_MILLION,
  TOKENS_PER_STAGE,
} from "./constants.js";
export class CurveError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CurveError";
    this.code = code;
  }
}
export function isCurveError(e: unknown): e is CurveError {
  return e instanceof CurveError;
}
export function getStageForSupply(supply: DisplayTokens): number {
  if (supply < 0n) {
    throw new CurveError("NEGATIVE_SUPPLY", "Supply cannot be negative.");
  }
  if (supply >= PUBLIC_SUPPLY_TOKENS) {
    return STAGE_COUNT;
  }
  const stage = Number(supply / TOKENS_PER_STAGE) + 1;
  return Math.min(stage, STAGE_COUNT);
}
export function getStagePrice(stage: number): Sats {
  if (!Number.isInteger(stage) || stage < 1 || stage > STAGE_COUNT) {
    throw new CurveError(
      "INVALID_STAGE",
      `Stage must be an integer between 1 and ${STAGE_COUNT}.`,
    );
  }
  const price = STAGE_PRICES_SATS_PER_MILLION[stage - 1]!;
  return price;
}
export function getStageSupplyRange(stage: number): {
  start: DisplayTokens;
  end: DisplayTokens;
} {
  if (!Number.isInteger(stage) || stage < 1 || stage > STAGE_COUNT) {
    throw new CurveError(
      "INVALID_STAGE",
      `Stage must be an integer between 1 and ${STAGE_COUNT}.`,
    );
  }
  const start = BigInt(stage - 1) * TOKENS_PER_STAGE;
  const end = BigInt(stage) * TOKENS_PER_STAGE;
  return { start, end };
}
