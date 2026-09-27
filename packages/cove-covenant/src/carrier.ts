import type { Sats } from "@crclaunch/curve";
export const TOKEN_CARRIER_SATS: Sats = 1000n;
export function isCarrierValue(valueSats: Sats): boolean {
  return valueSats >= TOKEN_CARRIER_SATS;
}
