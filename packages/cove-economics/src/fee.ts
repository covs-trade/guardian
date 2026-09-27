import type { Atoms, BasisPoints, Sats } from "@crclaunch/curve";
import { ATOMS_PER_TOKEN, LOT_TOKENS } from "@crclaunch/curve";
export interface CoveFeeConfig {
  buyFeeBps: BasisPoints;
  buyFeeFlatSats: Sats;
  buyFeeLotSats: Sats;
  creatorFeeBps: BasisPoints;
  redeemFeeBps: BasisPoints;
  redeemFeeFlatSats: Sats;
  redeemFeeMinSats: Sats;
  p2pFeeBps: BasisPoints;
  p2pFeeFlatSats: Sats;
  p2pFeeMinSats: Sats;
  launchFeeSats: Sats;
}
export const COVE_FEE_CONFIG: CoveFeeConfig = {
  buyFeeBps: 750n,
  buyFeeFlatSats: 5000n,
  buyFeeLotSats: 10n,
  creatorFeeBps: 5000n,
  redeemFeeBps: 750n,
  redeemFeeFlatSats: 0n,
  redeemFeeMinSats: 1000n,
  p2pFeeBps: 750n,
  p2pFeeFlatSats: 0n,
  p2pFeeMinSats: 1000n,
  launchFeeSats: 7000n,
};
export const LAUNCH_FEE_SATS: Sats = COVE_FEE_CONFIG.launchFeeSats;
const BPS_DENOM = 10000n;
export function deterministicFee(
  grossSats: Sats,
  feeBps: BasisPoints,
  flatSats: Sats = 0n,
  minSats: Sats = 0n,
): Sats {
  if (grossSats < 0n) throw new Error("grossSats must be non-negative");
  if (feeBps < 0n) throw new Error("feeBps must be non-negative");
  if (flatSats < 0n) throw new Error("flatSats must be non-negative");
  if (minSats < 0n) throw new Error("minSats must be non-negative");
  if (grossSats === 0n) return 0n;
  const pct =
    feeBps === 0n ? 0n : (grossSats * feeBps + BPS_DENOM - 1n) / BPS_DENOM;
  const fee = flatSats + pct;
  return fee < minSats ? minSats : fee;
}
export function mintFeeSats(
  grossSats: Sats,
  amountAtoms: Atoms,
  feeBps: BasisPoints,
  flatPerMintSats: Sats,
  perLotSats: Sats = COVE_FEE_CONFIG.buyFeeLotSats,
): Sats {
  const lots = amountAtoms / (LOT_TOKENS * ATOMS_PER_TOKEN);
  return deterministicFee(
    grossSats,
    feeBps,
    flatPerMintSats + perLotSats * lots,
  );
}
export const CREATOR_RECORD_SATS: Sats = 1000n;
export const CREATOR_MIN_SATS: Sats = 546n;
export function creatorFeeSats(
  grossSats: Sats,
  creatorBps: BasisPoints = COVE_FEE_CONFIG.creatorFeeBps,
): Sats {
  return deterministicFee(grossSats, creatorBps, 0n, CREATOR_MIN_SATS);
}
export function redeemFeeSats(
  grossSats: Sats,
  feeBps: BasisPoints = COVE_FEE_CONFIG.redeemFeeBps,
  flatSats: Sats = COVE_FEE_CONFIG.redeemFeeFlatSats,
  minSats: Sats = COVE_FEE_CONFIG.redeemFeeMinSats,
): Sats {
  return deterministicFee(grossSats, feeBps, flatSats, minSats);
}
export function isCreatorScript(script: Uint8Array): boolean {
  const s = script;
  const p2wpkh = s.length === 22 && s[0] === 0x00 && s[1] === 0x14;
  const p2tr = s.length === 34 && s[0] === 0x51 && s[1] === 0x20;
  const p2sh =
    s.length === 23 && s[0] === 0xa9 && s[1] === 0x14 && s[22] === 0x87;
  return p2wpkh || p2tr || p2sh;
}
