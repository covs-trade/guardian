import { eq, and, isNull } from "drizzle-orm";
import { schema, type Database } from "@crclaunch/db";
import { ATOMS_PER_TOKEN, PUBLIC_SUPPLY_ATOMS } from "@crclaunch/curve";
import {
  COVE_FEE_CONFIG,
  creatorFeeSats,
  deterministicFee,
  mintFeeSats,
  grossBuy,
  quoteRedeem,
} from "@crclaunch/cove-economics";
export interface BackingBuyBreakdown {
  grossSats: bigint;
  buyFeeSats: bigint;
  feeBps: bigint;
}
export interface P2PBuyBreakdown {
  listingId: string;
  sellerPriceSats: bigint;
  marketFeeSats: bigint;
  feeBps: bigint;
}
export type BuyRoute =
  | {
      kind: "backing";
      amountAtoms: bigint;
      totalCostSats: bigint;
      breakdown: BackingBuyBreakdown;
    }
  | {
      kind: "p2p";
      amountAtoms: bigint;
      totalCostSats: bigint;
      breakdown: P2PBuyBreakdown;
    };
export interface BuyRouteFees {
  buyFeeBps: bigint;
  p2pFeeBps: bigint;
  buyFeeFlatSats?: bigint;
  p2pFeeMinSats?: bigint;
}
export interface SellOption {
  kind: "backing" | "listable-utxo";
  amountAtoms: bigint;
  netSats: bigint;
  grossSats: bigint;
  feeSats: bigint;
  listingId?: string;
  txid?: string;
  vout?: number;
}
export async function getBuyRoutes(
  db: Database,
  network: string,
  tokenId: string,
  amountAtoms: bigint,
  fees: BuyRouteFees = {
    buyFeeBps: COVE_FEE_CONFIG.buyFeeBps,
    p2pFeeBps: COVE_FEE_CONFIG.p2pFeeBps,
  },
): Promise<BuyRoute[]> {
  const routes: BuyRoute[] = [];
  if (amountAtoms > 0n && amountAtoms % ATOMS_PER_TOKEN === 0n) {
    const backing = await db
      .select({ supplyAtoms: schema.coveV3BackingStates.issuedSupplyAtoms })
      .from(schema.coveV3BackingStates)
      .where(
        and(
          eq(schema.coveV3BackingStates.network, network),
          eq(schema.coveV3BackingStates.tokenId, tokenId),
          eq(schema.coveV3BackingStates.canonical, true),
        ),
      );
    const supplyAtoms = backing[0]?.supplyAtoms ?? 0n;
    if (supplyAtoms + amountAtoms <= PUBLIC_SUPPLY_ATOMS) {
      const grossSats = grossBuy(
        supplyAtoms / ATOMS_PER_TOKEN,
        amountAtoms / ATOMS_PER_TOKEN,
      );
      const buyFeeSats = mintFeeSats(
        grossSats,
        amountAtoms,
        fees.buyFeeBps,
        fees.buyFeeFlatSats ?? COVE_FEE_CONFIG.buyFeeFlatSats,
      );
      const creatorSats = creatorFeeSats(grossSats);
      routes.push({
        kind: "backing",
        amountAtoms,
        totalCostSats: grossSats + buyFeeSats + creatorSats,
        breakdown: { grossSats, buyFeeSats, feeBps: fees.buyFeeBps },
      });
    }
  }
  const listings = await db
    .select()
    .from(schema.coveV3MarketListings)
    .where(
      and(
        eq(schema.coveV3MarketListings.network, network),
        eq(schema.coveV3MarketListings.tokenId, tokenId),
        eq(schema.coveV3MarketListings.status, "ACTIVE"),
        eq(schema.coveV3MarketListings.amountAtoms, amountAtoms),
      ),
    );
  for (const l of listings) {
    const marketFeeSats = deterministicFee(
      l.totalPriceSats,
      fees.p2pFeeBps,
      0n,
      fees.p2pFeeMinSats ?? COVE_FEE_CONFIG.p2pFeeMinSats,
    );
    routes.push({
      kind: "p2p",
      amountAtoms,
      totalCostSats: l.totalPriceSats + marketFeeSats,
      breakdown: {
        listingId: l.listingId,
        sellerPriceSats: l.totalPriceSats,
        marketFeeSats,
        feeBps: fees.p2pFeeBps,
      },
    });
  }
  routes.sort((a, b) =>
    a.totalCostSats < b.totalCostSats
      ? -1
      : a.totalCostSats > b.totalCostSats
        ? 1
        : 0,
  );
  return routes;
}
export async function getSellOptions(
  db: Database,
  network: string,
  tokenId: string,
  ownerScript: string,
  redeemFeeBps: bigint = COVE_FEE_CONFIG.redeemFeeBps,
): Promise<{
  redeemQuote: SellOption | null;
  listableUtxos: SellOption[];
}> {
  const utxos = await db
    .select()
    .from(schema.coveV3TokenUtxos)
    .where(
      and(
        eq(schema.coveV3TokenUtxos.network, network),
        eq(schema.coveV3TokenUtxos.tokenId, tokenId),
        eq(schema.coveV3TokenUtxos.scriptPubKey, ownerScript),
        eq(schema.coveV3TokenUtxos.canonical, true),
        isNull(schema.coveV3TokenUtxos.spentByTxid),
      ),
    );
  const listableUtxos: SellOption[] = utxos.map((u) => ({
    kind: "listable-utxo",
    amountAtoms: u.amountAtoms,
    netSats: 0n,
    grossSats: 0n,
    feeSats: 0n,
    txid: u.txid,
    vout: u.vout,
  }));
  const balanceAtoms = utxos.reduce((s, u) => s + u.amountAtoms, 0n);
  let redeemQuote: SellOption | null = null;
  if (balanceAtoms > 0n && balanceAtoms % ATOMS_PER_TOKEN === 0n) {
    const backing = await db
      .select({ supplyAtoms: schema.coveV3BackingStates.issuedSupplyAtoms })
      .from(schema.coveV3BackingStates)
      .where(
        and(
          eq(schema.coveV3BackingStates.network, network),
          eq(schema.coveV3BackingStates.tokenId, tokenId),
          eq(schema.coveV3BackingStates.canonical, true),
        ),
      );
    const supplyAtoms = backing[0]?.supplyAtoms ?? 0n;
    if (balanceAtoms <= supplyAtoms) {
      const q = quoteRedeem(
        supplyAtoms / ATOMS_PER_TOKEN,
        balanceAtoms / ATOMS_PER_TOKEN,
        { ...COVE_FEE_CONFIG, redeemFeeBps },
      );
      redeemQuote = {
        kind: "backing",
        amountAtoms: balanceAtoms,
        netSats: q.net,
        grossSats: q.gross,
        feeSats: q.fee,
      };
    }
  }
  return { redeemQuote, listableUtxos };
}
