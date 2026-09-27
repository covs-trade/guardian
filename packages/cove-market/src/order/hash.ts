import { taggedHash } from "@crclaunch/cove-vault";
import { serializeListingV1 } from "./serialization.js";
import type { CancellationV1, ListingV1 } from "../types.js";
export const LISTING_DOMAIN = "Cove/Market/Listing/v1";
export const CANCEL_DOMAIN = "Cove/Market/Cancel/v1";
export const RESERVE_DOMAIN = "Cove/Market/Reserve/v1";
export function listingIdOf(l: ListingV1): string {
  return taggedHash(LISTING_DOMAIN, serializeListingV1(l)).toString("hex");
}
export function cancellationHashOf(c: CancellationV1): string {
  const buf = Buffer.concat([
    Buffer.from([c.version]),
    Buffer.from(c.listingId, "hex"),
    Buffer.from(c.cancelNonce, "hex"),
  ]);
  return taggedHash(CANCEL_DOMAIN, buf).toString("hex");
}
export function listingMessageToSign(l: ListingV1): string {
  return `COVE_MARKET_LISTING_V1:${listingIdOf(l)}`;
}
export function cancellationMessageToSign(c: CancellationV1): string {
  return `COVE_MARKET_CANCEL_V1:${cancellationHashOf(c)}`;
}
export interface ReservationV1 {
  version: 1;
  listingId: string;
  reserveNonce: string;
  buyerTokenScript: string;
}
export function reservationHashOf(r: ReservationV1): string {
  const buf = Buffer.concat([
    Buffer.from([r.version]),
    Buffer.from(r.listingId, "hex"),
    Buffer.from(r.reserveNonce, "hex"),
    Buffer.from(r.buyerTokenScript, "hex"),
  ]);
  return taggedHash(RESERVE_DOMAIN, buf).toString("hex");
}
export function reservationMessageToSign(r: ReservationV1): string {
  return `COVE_MARKET_RESERVE_V1:${reservationHashOf(r)}`;
}
