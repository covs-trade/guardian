import type { Sats } from "@crclaunch/curve";
import { dustThreshold } from "./dust.js";
export interface RedeemPayoutCheck {
  grossSats: Sats;
  feeSats: Sats;
  netSats: Sats;
  dustThresholdSats: Sats;
  isPayable: boolean;
  minimumGrossSats: Sats;
}
export function checkRedeemPayout(
  grossSats: Sats,
  feeSats: Sats,
  payoutScript: Uint8Array,
): RedeemPayoutCheck {
  if (grossSats < 0n) throw new Error("grossSats must be non-negative");
  if (feeSats < 0n) throw new Error("feeSats must be non-negative");
  const dust = dustThreshold(payoutScript);
  const netSats = grossSats - feeSats;
  return {
    grossSats,
    feeSats,
    netSats,
    dustThresholdSats: dust,
    isPayable: netSats >= dust,
    minimumGrossSats: feeSats + dust,
  };
}
