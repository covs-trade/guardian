import type { OperationStatus, VerificationStatus } from "./types.js";
export const VERIFIED: OperationStatus = "VERIFIED";
export const UNVERIFIED: OperationStatus = "UNVERIFIED";
export const PRECOP_MAINNET_VERIFICATION: VerificationStatus = Object.freeze({
  deploy: "UNVERIFIED",
  mint: "UNVERIFIED",
  transfer: "UNVERIFIED",
  dexAsk: "UNVERIFIED",
  dexBid: "UNVERIFIED",
  cancel: "UNVERIFIED",
  graduation: "UNVERIFIED",
});
export const MOCK_VERIFICATION: VerificationStatus = Object.freeze({
  deploy: "VERIFIED",
  mint: "VERIFIED",
  transfer: "VERIFIED",
  dexAsk: "VERIFIED",
  dexBid: "VERIFIED",
  cancel: "VERIFIED",
  graduation: "VERIFIED",
});
export function opStatusFor(
  status: VerificationStatus,
  op: keyof VerificationStatus,
): OperationStatus {
  return status[op];
}
