import type { Sats } from "@crclaunch/curve";
import { isCreatorScript } from "./fee.js";
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

export function isValidRedeemPayout(
  grossSats: Sats,
  feeSats: Sats,
  payoutSats: Sats,
  payoutScript: Uint8Array,
): boolean {
  if (payoutSats < 0n) return false;
  if (payoutSats === grossSats - feeSats) return true;
  return (
    isCreatorScript(payoutScript) &&
    payoutSats >= grossSats &&
    payoutSats >= dustThreshold(payoutScript)
  );
}

export function redeemWalletFundingTarget(
  grossSats: Sats,
  feeSats: Sats,
  payoutScript: Uint8Array,
  carrierSatsIn: Sats,
  changeCarrierSats: Sats,
): Sats {
  const dust = dustThreshold(payoutScript);
  const topUp = grossSats < dust ? dust - grossSats : 0n;
  return feeSats + changeCarrierSats - carrierSatsIn + topUp;
}
