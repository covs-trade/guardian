import { isP2TR, isP2WPKH } from "@crclaunch/cove-economics";
import { isP2SH } from "@crclaunch/bitcoin";
import { MARKET_ORDER_VERSION, type ListingV1 } from "../types.js";
import { MarketError } from "../errors.js";
function standardCarrierScript(scriptHex: string): boolean {
  if (!/^[0-9a-f]*$/i.test(scriptHex)) return false;
  const script = Buffer.from(scriptHex, "hex");
  return isP2WPKH(script) || isP2TR(script);
}
function standardPayoutScript(scriptHex: string): boolean {
  if (!/^[0-9a-f]*$/i.test(scriptHex)) return false;
  const script = Buffer.from(scriptHex, "hex");
  return isP2WPKH(script) || isP2TR(script) || isP2SH(script);
}
export function validateListingShape(l: ListingV1): void {
  if (l.orderVersion !== MARKET_ORDER_VERSION)
    throw new MarketError("LISTING_BAD_VERSION", "orderVersion != 1");
  if (!/^[0-9a-f]{64}$/.test(l.tokenId))
    throw new MarketError("LISTING_TOKEN_MISMATCH", "bad tokenId");
  if (!/^[0-9a-f]{64}$/.test(l.sourceTxid))
    throw new MarketError("LISTING_BAD_SOURCE", "bad sourceTxid");
  if (!/^[0-9a-f]{64}$/.test(l.nonce))
    throw new MarketError("LISTING_BAD_SOURCE", "bad nonce");
  if (!standardCarrierScript(l.sellerTokenScript))
    throw new MarketError(
      "LISTING_BAD_SOURCE",
      "seller token script not standard",
    );
  if (!standardPayoutScript(l.sellerPayoutScript))
    throw new MarketError(
      "LISTING_BAD_SOURCE",
      "seller payout script not standard",
    );
  if (l.sellerTokenChangeScript !== l.sellerTokenScript) {
    throw new MarketError(
      "LISTING_BAD_SOURCE",
      "V1 requires the change script to equal the token script",
    );
  }
  if (l.sourceVout < 0)
    throw new MarketError("LISTING_BAD_SOURCE", "bad sourceVout");
  if (l.amountAtoms <= 0n)
    throw new MarketError("LISTING_AMOUNT_INVALID", "zero amount");
  if (l.amountAtoms > l.sourceAmountAtoms)
    throw new MarketError("LISTING_AMOUNT_INVALID", "amount > source amount");
  if (l.totalPriceSats <= 0n)
    throw new MarketError("LISTING_PRICE_INVALID", "zero price");
  if (l.expiryHeight <= l.creationHeight)
    throw new MarketError("LISTING_EXPIRED", "expiry <= creation");
}
