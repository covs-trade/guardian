import { MARKET_ORDER_VERSION, type ListingV1 } from "../types.js";
import { MarketError } from "../errors.js";
const U64_MAX = 0xffffffffffffffffn;
const U32_MAX = 0xffffffffn;
function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n, 0);
  return b;
}
function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}
function u64(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(n, 0);
  return b;
}
function pushScript(buf: Buffer[], scriptHex: string): void {
  if (!/^[0-9a-f]*$/i.test(scriptHex))
    throw new MarketError("LISTING_BAD_SOURCE", "script not hex");
  const script = Buffer.from(scriptHex, "hex");
  if (script.length > 0xffff)
    throw new MarketError("LISTING_BAD_SOURCE", "script too long");
  buf.push(u16(script.length), script);
}
export function serializeListingV1(l: ListingV1): Buffer {
  if (l.orderVersion !== MARKET_ORDER_VERSION) {
    throw new MarketError("LISTING_BAD_VERSION", `version ${l.orderVersion}`);
  }
  if (!/^[0-9a-f]{64}$/.test(l.tokenId))
    throw new MarketError("LISTING_TOKEN_MISMATCH", "bad tokenId");
  if (!/^[0-9a-f]{64}$/.test(l.sourceTxid))
    throw new MarketError("LISTING_BAD_SOURCE", "bad sourceTxid");
  if (!/^[0-9a-f]{64}$/.test(l.nonce))
    throw new MarketError("LISTING_BAD_SOURCE", "bad nonce");
  if (l.sourceVout < 0 || l.sourceVout > U32_MAX)
    throw new MarketError("LISTING_BAD_SOURCE", "bad sourceVout");
  for (const v of [
    l.sourceAmountAtoms,
    l.amountAtoms,
    l.totalPriceSats,
    l.creationHeight,
    l.expiryHeight,
  ]) {
    if (v < 0n || v > U64_MAX)
      throw new MarketError("LISTING_BAD_SOURCE", "value out of u64 range");
  }
  if (l.amountAtoms <= 0n)
    throw new MarketError("LISTING_AMOUNT_INVALID", "zero amount");
  if (l.totalPriceSats <= 0n)
    throw new MarketError("LISTING_PRICE_INVALID", "zero price");
  const chain = Buffer.from(l.chainIdentity, "utf8");
  if (chain.length === 0 || chain.length > 0xffff)
    throw new MarketError("LISTING_BAD_SOURCE", "bad chainIdentity");
  const parts: Buffer[] = [
    Buffer.from([l.orderVersion]),
    u16(chain.length),
    chain,
    Buffer.from(l.tokenId, "hex"),
  ];
  pushScript(parts, l.sellerTokenScript);
  pushScript(parts, l.sellerPayoutScript);
  pushScript(parts, l.sellerTokenChangeScript);
  parts.push(Buffer.from(l.sourceTxid, "hex"));
  parts.push(u32(l.sourceVout));
  parts.push(u64(l.sourceAmountAtoms));
  parts.push(u64(l.amountAtoms));
  parts.push(u64(l.totalPriceSats));
  parts.push(u64(l.creationHeight));
  parts.push(u64(l.expiryHeight));
  parts.push(Buffer.from(l.nonce, "hex"));
  return Buffer.concat(parts);
}
