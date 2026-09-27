import type { DisplayTokens, Sats } from "@crclaunch/curve";
import { ATOMS_PER_TOKEN } from "@crclaunch/curve";
import { stairs210, PUBLIC_SUPPLY } from "./curve.js";
import {
  mintFeeSats,
  redeemFeeSats,
  COVE_FEE_CONFIG,
  type CoveFeeConfig,
} from "./fee.js";
export function requiredBackingSats(supply: DisplayTokens): Sats {
  assertSupplyInRange(supply);
  return stairs210.costToBuy(0n, supply);
}
export interface Quote {
  gross: Sats;
  fee: Sats;
  net: Sats;
}
export class BackingError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "BackingError";
    this.code = code;
  }
}
function assertSupplyInRange(supply: DisplayTokens): void {
  if (supply < 0n)
    throw new BackingError("INVALID_SUPPLY", "supply must be non-negative");
  if (supply > PUBLIC_SUPPLY)
    throw new BackingError("PUBLIC_CAP_EXCEEDED", "supply exceeds public cap");
}
function assertPositiveDelta(gross: Sats): void {
  if (gross < 1n) {
    throw new BackingError(
      "ECONOMIC_DUST",
      "zero backing delta: positive quantity produced a 0-sat R-delta",
    );
  }
}
export function grossBuy(supply: DisplayTokens, amount: DisplayTokens): Sats {
  assertSupplyInRange(supply);
  if (amount <= 0n)
    throw new BackingError("INVALID_AMOUNT", "amount must be positive");
  if (supply + amount > PUBLIC_SUPPLY)
    throw new BackingError("PUBLIC_CAP_EXCEEDED", "public cap exceeded");
  const gross =
    requiredBackingSats(supply + amount) - requiredBackingSats(supply);
  assertPositiveDelta(gross);
  return gross;
}
export function grossRedeem(
  supply: DisplayTokens,
  amount: DisplayTokens,
): Sats {
  assertSupplyInRange(supply);
  if (amount <= 0n)
    throw new BackingError("INVALID_AMOUNT", "amount must be positive");
  if (amount > supply)
    throw new BackingError(
      "INSUFFICIENT_TOKEN_BALANCE",
      "redeem amount exceeds issued supply",
    );
  const gross =
    requiredBackingSats(supply) - requiredBackingSats(supply - amount);
  assertPositiveDelta(gross);
  return gross;
}
export function quoteBuy(
  supply: DisplayTokens,
  amount: DisplayTokens,
  feeConfig: CoveFeeConfig = COVE_FEE_CONFIG,
): Quote {
  const gross = grossBuy(supply, amount);
  const fee = mintFeeSats(
    gross,
    amount * ATOMS_PER_TOKEN,
    feeConfig.buyFeeBps,
    feeConfig.buyFeeFlatSats,
    feeConfig.buyFeeLotSats,
  );
  return { gross, fee, net: gross + fee };
}
export function quoteRedeem(
  supply: DisplayTokens,
  amount: DisplayTokens,
  feeConfig: CoveFeeConfig = COVE_FEE_CONFIG,
): Quote {
  const gross = grossRedeem(supply, amount);
  const fee = redeemFeeSats(
    gross,
    feeConfig.redeemFeeBps,
    feeConfig.redeemFeeFlatSats,
    feeConfig.redeemFeeMinSats,
  );
  return { gross, fee, net: gross - fee };
}
