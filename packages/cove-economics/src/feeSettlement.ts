import type { BasisPoints, Sats } from "@crclaunch/curve";
import { dustThreshold } from "./dust.js";
const BPS_DENOM = 10000n;
export interface FeeSettlementCheck {
  nominalFeeSats: Sats;
  feeScript: Uint8Array;
  dustThresholdSats: Sats;
  isStandard: boolean;
  minimumGrossForStandardFeeOutput: Sats | null;
}
export function checkFeeSettlement(
  nominalFeeSats: Sats,
  feeScript: Uint8Array,
  feeBps: BasisPoints,
): FeeSettlementCheck {
  if (nominalFeeSats < 0n)
    throw new Error("nominalFeeSats must be non-negative");
  const dust = dustThreshold(feeScript);
  const isStandard = nominalFeeSats === 0n || nominalFeeSats >= dust;
  const minimumGross =
    feeBps === 0n ? null : ((dust - 1n) * BPS_DENOM) / feeBps + 1n;
  return {
    nominalFeeSats,
    feeScript,
    dustThresholdSats: dust,
    isStandard,
    minimumGrossForStandardFeeOutput: minimumGross,
  };
}
