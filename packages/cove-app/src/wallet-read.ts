import { eq, and, or, inArray } from "drizzle-orm";
import { schema, type Database } from "@crclaunch/db";
import {
  getTokenUtxosByScriptDb,
  getBalanceByScriptDb,
} from "@crclaunch/cove-indexer/v3";
export interface Holding {
  tokenId: string;
  amountAtoms: bigint;
  utxoCount: number;
}
export async function getWalletPortfolio(
  db: Database,
  network: string,
  walletScript: string,
) {
  const utxos = await getTokenUtxosByScriptDb(db, network, walletScript);
  const byToken = new Map<string, Holding>();
  for (const u of utxos) {
    const h = byToken.get(u.tokenId) ?? {
      tokenId: u.tokenId,
      amountAtoms: 0n,
      utxoCount: 0,
    };
    h.amountAtoms += u.amountAtoms;
    h.utxoCount += 1;
    byToken.set(u.tokenId, h);
  }
  const holdings = [...byToken.values()].sort((a, b) =>
    a.tokenId < b.tokenId ? -1 : 1,
  );
  const listingRows = await db
    .select()
    .from(schema.coveV3MarketListings)
    .where(
      and(
        eq(schema.coveV3MarketListings.network, network),
        or(
          eq(schema.coveV3MarketListings.sellerTokenScript, walletScript),
          eq(schema.coveV3MarketListings.sellerPayoutScript, walletScript),
        ),
      ),
    );
  const listings = listingRows.map(
    ({ sellerPresignedPsbt: _secret, ...rest }) => {
      void _secret;
      return rest;
    },
  );
  const sellerListingIds = listings.map((l) => l.listingId);
  const fills = await db
    .select()
    .from(schema.coveV3MarketFills)
    .where(
      and(
        eq(schema.coveV3MarketFills.network, network),
        or(
          eq(schema.coveV3MarketFills.buyerTokenScript, walletScript),
          eq(schema.coveV3MarketFills.buyerChangeScript, walletScript),
          ...(sellerListingIds.length > 0
            ? [inArray(schema.coveV3MarketFills.listingId, sellerListingIds)]
            : []),
        ),
      ),
    );
  return {
    walletScript,
    holdings,
    tokenUtxos: utxos.map((u) => ({
      txid: u.txid,
      vout: u.vout,
      tokenId: u.tokenId,
      amountAtoms: u.amountAtoms,
      scriptPubKey: u.scriptPubKey,
    })),
    listings,
    fills,
  };
}
export async function getWalletBalanceAtoms(
  db: Database,
  network: string,
  tokenId: string,
  walletScript: string,
): Promise<bigint> {
  return getBalanceByScriptDb(db, network, tokenId, walletScript);
}
