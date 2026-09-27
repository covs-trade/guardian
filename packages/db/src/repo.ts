import { and, asc, desc, eq, inArray, notInArray, or, sql } from "drizzle-orm";
import type { Database, DbTransaction } from "./client.js";
import {
  assertListingTransition,
  assertTokenTransition,
  assertTxTransition,
} from "./state-machine.js";
import type { ListingStatus, TokenStatus, TxStatus } from "./status.js";
import {
  blocks,
  chainEvents,
  chainTransactions,
  indexerCursors,
  listings,
  mints,
  quotes,
  reorgEvents,
  tokenMetadata,
  tokens,
  trades,
  walletTokenBalances,
  feeLedger,
} from "./schema.js";
type DB = Database | DbTransaction;
function jsonSafe(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  return JSON.parse(
    JSON.stringify(value, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    ),
  );
}
export interface NewToken {
  deploymentTxid: string;
  ticker: string;
  tickerNormalized: string;
  name: string;
  creatorAddress: string;
  network: string;
  status?: TokenStatus;
  totalSupplyAtoms: bigint;
  publicSupplyAtoms: bigint;
  reserveSupplyAtoms: bigint;
}
export async function insertDraftToken(db: DB, input: NewToken) {
  const [row] = await db
    .insert(tokens)
    .values({
      deploymentTxid: input.deploymentTxid,
      ticker: input.ticker,
      tickerNormalized: input.tickerNormalized,
      name: input.name,
      creatorAddress: input.creatorAddress,
      network: input.network,
      status: input.status ?? "DRAFT",
      totalSupplyAtoms: input.totalSupplyAtoms,
      publicSupplyAtoms: input.publicSupplyAtoms,
      reserveSupplyAtoms: input.reserveSupplyAtoms,
    })
    .returning();
  if (!row) throw new Error("Failed to insert token.");
  return row;
}
export async function getTokenByDeployment(
  db: DB,
  network: string,
  deploymentTxid: string,
) {
  const [row] = await db
    .select()
    .from(tokens)
    .where(
      and(
        eq(tokens.network, network),
        eq(tokens.deploymentTxid, deploymentTxid),
      ),
    )
    .limit(1);
  return row ?? null;
}
export async function getTokenByTicker(
  db: DB,
  network: string,
  tickerNormalized: string,
) {
  const [row] = await db
    .select()
    .from(tokens)
    .where(
      and(
        eq(tokens.network, network),
        eq(tokens.tickerNormalized, tickerNormalized),
      ),
    )
    .limit(1);
  return row ?? null;
}
export async function listTokens(
  db: DB,
  opts: {
    network?: string;
    status?: string;
    limit?: number;
    offset?: number;
  } = {},
) {
  const conditions = [];
  if (opts.network) conditions.push(eq(tokens.network, opts.network));
  if (opts.status) conditions.push(eq(tokens.status, opts.status));
  return db
    .select()
    .from(tokens)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(tokens.createdAt))
    .limit(opts.limit ?? 25)
    .offset(opts.offset ?? 0);
}
export async function setTokenStatus(
  db: DB,
  tokenId: string,
  from: TokenStatus,
  to: TokenStatus,
) {
  assertTokenTransition(from, to);
  const [row] = await db
    .update(tokens)
    .set({ status: to, updatedAt: new Date() })
    .where(and(eq(tokens.id, tokenId), eq(tokens.status, from)))
    .returning();
  return row;
}
export async function updateTokenState(
  db: DB,
  tokenId: string,
  patch: {
    confirmedMintedAtoms?: bigint;
    pendingMintedAtoms?: bigint;
    currentStage?: number;
    status?: TokenStatus;
    protocolStateHash?: string;
    reserveSats?: bigint;
    lastTradePricePerMillion?: bigint | null;
  },
) {
  const [row] = await db
    .update(tokens)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(tokens.id, tokenId))
    .returning();
  return row;
}
export async function upsertTokenMetadata(
  db: DB,
  deploymentTxid: string,
  patch: Record<string, unknown>,
) {
  const [row] = await db
    .insert(tokenMetadata)
    .values({ deploymentTxid, ...patch })
    .onConflictDoUpdate({
      target: tokenMetadata.deploymentTxid,
      set: { ...patch, updatedAt: new Date() },
    })
    .returning();
  return row;
}
export async function getTokenMetadataForDeployment(
  db: DB,
  deploymentTxid: string,
) {
  const [row] = await db
    .select()
    .from(tokenMetadata)
    .where(eq(tokenMetadata.deploymentTxid, deploymentTxid))
    .limit(1);
  return row ?? null;
}
export async function listMetadataByDeploymentTxids(
  db: DB,
  deploymentTxids: string[],
) {
  if (deploymentTxids.length === 0) return [];
  return db
    .select()
    .from(tokenMetadata)
    .where(inArray(tokenMetadata.deploymentTxid, deploymentTxids));
}
export async function listHolders(
  db: DB,
  network: string,
  deploymentId: string,
  limit = 25,
  offset = 0,
) {
  return db
    .select()
    .from(walletTokenBalances)
    .where(
      and(
        eq(walletTokenBalances.network, network),
        eq(walletTokenBalances.deploymentId, deploymentId),
      ),
    )
    .orderBy(desc(walletTokenBalances.balanceAtoms))
    .limit(limit)
    .offset(offset);
}
export interface ChainEventInput {
  network: string;
  blockHeight: bigint;
  blockHash: string;
  txid: string;
  eventIndex: number;
  eventType: string;
  deploymentId: string | null;
  walletFrom: string | null;
  walletTo: string | null;
  tokenAmountAtoms: bigint | null;
  btcAmountSats: bigint | null;
  payloadJson: unknown;
  canonical?: boolean;
}
export async function upsertChainEvent(db: DB, e: ChainEventInput) {
  await db
    .insert(chainEvents)
    .values({
      network: e.network,
      blockHeight: e.blockHeight,
      blockHash: e.blockHash,
      txid: e.txid,
      eventIndex: e.eventIndex,
      eventType: e.eventType,
      deploymentId: e.deploymentId,
      walletFrom: e.walletFrom,
      walletTo: e.walletTo,
      tokenAmountAtoms: e.tokenAmountAtoms,
      btcAmountSats: e.btcAmountSats,
      payloadJson: jsonSafe(e.payloadJson),
      canonical: e.canonical ?? true,
    })
    .onConflictDoUpdate({
      target: [chainEvents.network, chainEvents.txid, chainEvents.eventIndex],
      set: {
        blockHeight: e.blockHeight,
        blockHash: e.blockHash,
        canonical: e.canonical ?? true,
        eventType: e.eventType,
        deploymentId: e.deploymentId,
        walletFrom: e.walletFrom,
        walletTo: e.walletTo,
        tokenAmountAtoms: e.tokenAmountAtoms,
        btcAmountSats: e.btcAmountSats,
        payloadJson: jsonSafe(e.payloadJson),
      },
    });
}
export async function listEventsForToken(
  db: DB,
  deploymentId: string,
  limit = 25,
  offset = 0,
) {
  return db
    .select()
    .from(chainEvents)
    .where(
      and(
        eq(chainEvents.deploymentId, deploymentId),
        eq(chainEvents.canonical, true),
      ),
    )
    .orderBy(desc(chainEvents.blockHeight))
    .limit(limit)
    .offset(offset);
}
export async function markEventsNonCanonical(
  db: DB,
  network: string,
  hashes: string[],
) {
  if (hashes.length === 0) return;
  await db
    .update(chainEvents)
    .set({ canonical: false })
    .where(
      and(
        eq(chainEvents.network, network),
        inArray(chainEvents.blockHash, hashes),
      ),
    );
}
export async function upsertBlock(
  db: DB,
  b: {
    network: string;
    height: bigint;
    hash: string;
    parentHash: string;
    canonical?: boolean;
  },
) {
  await db
    .insert(blocks)
    .values({ ...b, canonical: b.canonical ?? true })
    .onConflictDoUpdate({
      target: [blocks.network, blocks.height],
      set: {
        hash: b.hash,
        parentHash: b.parentHash,
        canonical: b.canonical ?? true,
      },
    });
}
export async function getBlock(db: DB, network: string, height: bigint) {
  const [row] = await db
    .select()
    .from(blocks)
    .where(and(eq(blocks.network, network), eq(blocks.height, height)))
    .limit(1);
  return row ?? null;
}
export async function getCursor(db: DB, id: string) {
  const [row] = await db
    .select()
    .from(indexerCursors)
    .where(eq(indexerCursors.id, id))
    .limit(1);
  return row ?? null;
}
export async function setCursor(
  db: DB,
  id: string,
  network: string,
  height: bigint,
  hash: string | null,
) {
  await db
    .insert(indexerCursors)
    .values({
      id,
      network,
      lastHeight: height,
      lastBlockHash: hash,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: indexerCursors.id,
      set: {
        network,
        lastHeight: height,
        lastBlockHash: hash,
        updatedAt: new Date(),
      },
    });
}
export async function insertListing(
  db: DB,
  l: {
    listingId: string;
    network: string;
    deploymentId: string;
    sellerAddress: string;
    tokenAmountAtoms: bigint;
    askingPriceSats: bigint;
    creationHeight: bigint;
    expiryHeight: bigint;
    status?: ListingStatus;
    txid?: string;
  },
) {
  const [row] = await db
    .insert(listings)
    .values({ ...l, status: l.status ?? "OPEN" })
    .onConflictDoNothing({ target: listings.listingId })
    .returning();
  return row;
}
export async function getListingById(db: DB, listingId: string) {
  const [row] = await db
    .select()
    .from(listings)
    .where(eq(listings.listingId, listingId))
    .limit(1);
  return row ?? null;
}
export async function listOpenListings(
  db: DB,
  deploymentId: string,
  limit = 25,
  offset = 0,
) {
  return db
    .select()
    .from(listings)
    .where(
      and(eq(listings.deploymentId, deploymentId), eq(listings.status, "OPEN")),
    )
    .orderBy(asc(listings.createdAt))
    .limit(limit)
    .offset(offset);
}
export async function setListingStatus(
  db: DB,
  listingId: string,
  from: ListingStatus,
  to: ListingStatus,
) {
  assertListingTransition(from, to);
  const [row] = await db
    .update(listings)
    .set({ status: to, updatedAt: new Date() })
    .where(and(eq(listings.listingId, listingId), eq(listings.status, from)))
    .returning();
  return row;
}
export async function forceSetListingStatus(
  db: DB,
  listingId: string,
  status: string,
) {
  await db
    .update(listings)
    .set({ status, updatedAt: new Date() })
    .where(eq(listings.listingId, listingId));
}
export async function insertTrade(
  db: DB,
  t: {
    network: string;
    deploymentId: string;
    listingId: string;
    buyerAddress: string;
    sellerAddress: string;
    tokenAmountAtoms: bigint;
    priceSats: bigint;
    pricePerMillionSats: bigint;
    protocolFeeSats: bigint;
    platformFeeSats: bigint;
    txid: string;
    blockHeight: bigint;
  },
) {
  await db
    .insert(trades)
    .values(t)
    .onConflictDoNothing({ target: [trades.network, trades.txid] });
}
export async function insertMint(
  db: DB,
  m: {
    network: string;
    deploymentId: string;
    walletAddress: string;
    tokenAmountAtoms: bigint;
    curveContributionSats: bigint;
    platformFeeSats: bigint;
    minerFeeSats: bigint;
    txid?: string | null;
    status?: TxStatus;
    blockHeight?: bigint | null;
    canonical?: boolean;
  },
) {
  const [row] = await db
    .insert(mints)
    .values({ ...m, txid: m.txid ?? null, status: m.status ?? "CREATED" })
    .onConflictDoUpdate({
      target: [mints.network, mints.txid],
      set: {
        status: m.status ?? "CREATED",
        blockHeight: m.blockHeight ?? null,
        canonical: m.canonical ?? true,
      },
    })
    .returning();
  return row ?? null;
}
export async function updateMintByTxid(
  db: DB,
  network: string,
  txid: string,
  patch: {
    status?: TxStatus;
    blockHeight?: bigint | null;
    canonical?: boolean;
  },
) {
  await db
    .update(mints)
    .set({ ...patch, txid })
    .where(and(eq(mints.network, network), eq(mints.txid, txid)));
}
export async function insertQuote(
  db: DB,
  q: {
    network: string;
    deploymentId: string;
    walletAddress: string;
    mode: string;
    tokensAtoms: bigint;
    curveContributionSats: bigint;
    platformFeeSats: bigint;
    estimatedMinerFeeSats: bigint;
    totalEstimatedSpendSats: bigint;
    startingStage: number;
    endingStage: number;
    supplyBeforeAtoms: bigint;
    supplyAfterAtoms: bigint;
    stateHash: string;
    expiresAtHeight: bigint;
    expiresAt: Date;
  },
) {
  const [row] = await db.insert(quotes).values(q).returning();
  return row;
}
export async function getQuote(db: DB, id: string) {
  const [row] = await db
    .select()
    .from(quotes)
    .where(eq(quotes.id, id))
    .limit(1);
  return row ?? null;
}
export async function createChainTx(
  db: DB,
  t: {
    network: string;
    operation: string;
    walletAddress: string;
    idempotencyKey: string;
    txid?: string | null;
    status?: TxStatus;
    deploymentId?: string | null;
    payloadJson?: unknown;
  },
) {
  const [row] = await db
    .insert(chainTransactions)
    .values({
      ...t,
      txid: t.txid ?? null,
      deploymentId: t.deploymentId ?? null,
      status: t.status ?? "CREATED",
      payloadJson: jsonSafe(t.payloadJson ?? null),
    })
    .onConflictDoNothing({
      target: [
        chainTransactions.walletAddress,
        chainTransactions.operation,
        chainTransactions.idempotencyKey,
      ],
    })
    .returning();
  return row ?? null;
}
export async function getChainTxByIdempotency(
  db: DB,
  walletAddress: string,
  operation: string,
  idempotencyKey: string,
) {
  const [row] = await db
    .select()
    .from(chainTransactions)
    .where(
      and(
        eq(chainTransactions.walletAddress, walletAddress),
        eq(chainTransactions.operation, operation),
        eq(chainTransactions.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  return row ?? null;
}
export async function getChainTxByTxid(db: DB, network: string, txid: string) {
  const [row] = await db
    .select()
    .from(chainTransactions)
    .where(
      and(
        eq(chainTransactions.network, network),
        eq(chainTransactions.txid, txid),
      ),
    )
    .limit(1);
  return row ?? null;
}
export async function forceSetChainTxStatus(
  db: DB,
  id: string,
  status: string,
) {
  await db
    .update(chainTransactions)
    .set({ status, updatedAt: new Date() })
    .where(eq(chainTransactions.id, id));
}
export async function updateChainTxStatus(
  db: DB,
  id: string,
  from: TxStatus,
  to: TxStatus,
  extra: {
    txid?: string | null;
    errorCode?: string | null;
  } = {},
) {
  assertTxTransition(from, to);
  const [row] = await db
    .update(chainTransactions)
    .set({
      status: to,
      updatedAt: new Date(),
      ...(extra.txid !== undefined ? { txid: extra.txid } : {}),
      ...(extra.errorCode !== undefined ? { errorCode: extra.errorCode } : {}),
    })
    .where(
      and(eq(chainTransactions.id, id), eq(chainTransactions.status, from)),
    )
    .returning();
  return row;
}
export async function upsertBalance(
  db: DB,
  b: {
    network: string;
    walletAddress: string;
    deploymentId: string;
    balanceAtoms?: bigint;
    pendingAtoms?: bigint;
    lockedAtoms?: bigint;
  },
) {
  await db
    .insert(walletTokenBalances)
    .values({
      network: b.network,
      walletAddress: b.walletAddress,
      deploymentId: b.deploymentId,
      balanceAtoms: b.balanceAtoms ?? 0n,
      pendingAtoms: b.pendingAtoms ?? 0n,
      lockedAtoms: b.lockedAtoms ?? 0n,
    })
    .onConflictDoUpdate({
      target: [
        walletTokenBalances.network,
        walletTokenBalances.walletAddress,
        walletTokenBalances.deploymentId,
      ],
      set: {
        balanceAtoms: b.balanceAtoms ?? 0n,
        pendingAtoms: b.pendingAtoms ?? 0n,
        lockedAtoms: b.lockedAtoms ?? 0n,
        updatedAt: new Date(),
      },
    });
}
export async function listBalancesForWallet(
  db: DB,
  network: string,
  walletAddress: string,
) {
  return db
    .select()
    .from(walletTokenBalances)
    .where(
      and(
        eq(walletTokenBalances.network, network),
        eq(walletTokenBalances.walletAddress, walletAddress),
      ),
    );
}
export async function listMintsByWallet(
  db: DB,
  network: string,
  walletAddress: string,
  limit = 50,
) {
  return db
    .select()
    .from(mints)
    .where(
      and(eq(mints.network, network), eq(mints.walletAddress, walletAddress)),
    )
    .orderBy(desc(mints.createdAt))
    .limit(limit);
}
export async function listTradesByWallet(
  db: DB,
  network: string,
  walletAddress: string,
  limit = 50,
) {
  return db
    .select()
    .from(trades)
    .where(
      and(
        eq(trades.network, network),
        or(
          eq(trades.buyerAddress, walletAddress),
          eq(trades.sellerAddress, walletAddress),
        ),
      ),
    )
    .orderBy(desc(trades.createdAt))
    .limit(limit);
}
export async function listListingsBySeller(
  db: DB,
  network: string,
  sellerAddress: string,
  limit = 50,
) {
  return db
    .select()
    .from(listings)
    .where(
      and(
        eq(listings.network, network),
        eq(listings.sellerAddress, sellerAddress),
      ),
    )
    .orderBy(desc(listings.createdAt))
    .limit(limit);
}
export async function listChainEventsByWallet(
  db: DB,
  network: string,
  walletAddress: string,
  limit = 50,
) {
  return db
    .select()
    .from(chainEvents)
    .where(
      and(
        eq(chainEvents.network, network),
        eq(chainEvents.canonical, true),
        or(
          eq(chainEvents.walletFrom, walletAddress),
          eq(chainEvents.walletTo, walletAddress),
        ),
      ),
    )
    .orderBy(desc(chainEvents.blockHeight))
    .limit(limit);
}
export async function insertReorgEvent(
  db: DB,
  r: {
    network: string;
    fromHeight: bigint;
    toHeight: bigint;
    orphanedBlockHash: string | null;
    details?: unknown;
  },
) {
  await db
    .insert(reorgEvents)
    .values({ ...r, details: jsonSafe(r.details ?? null) });
}
export async function insertFeeLedgerRow(
  db: DB,
  f: {
    network: string;
    txid: string;
    eventIndex: number;
    operation: string;
    expectedSats: bigint;
    observedSats: bigint;
    confirmationStatus?: string;
    canonical?: boolean;
  },
) {
  await db
    .insert(feeLedger)
    .values({
      ...f,
      confirmationStatus: f.confirmationStatus ?? "PENDING",
      canonical: f.canonical ?? true,
    })
    .onConflictDoNothing({
      target: [feeLedger.network, feeLedger.txid, feeLedger.eventIndex],
    });
}
const PROJECTION_TABLES = [
  "fee_ledger",
  "protocol_snapshots",
  "quotes",
  "mints",
  "trades",
  "listings",
  "wallet_token_balances",
  "chain_events",
  "chain_transactions",
  "blocks",
  "indexer_cursors",
  "deployments",
  "tokens",
  "cove_blocks",
  "cove_operations",
  "cove_tokens",
  "cove_balances",
  "cove_checkpoints",
  "cove_cursor",
];
const PRESERVED_TABLES = [
  "token_metadata",
  "reorg_events",
  "reports",
  "terms_acceptances",
  "admin_audit_logs",
  "media",
];
export async function resetProjections(
  db: Database,
  network: string,
): Promise<void> {
  for (const table of PROJECTION_TABLES) {
    await db.execute(
      sql`DELETE FROM ${sql.raw(table)} WHERE network = ${network}`,
    );
  }
}
export async function resetAllTables(db: Database): Promise<void> {
  await db.execute(
    sql.raw(
      `TRUNCATE TABLE ${[...PROJECTION_TABLES, ...PRESERVED_TABLES].join(", ")} CASCADE`,
    ),
  );
}
export async function markEventsNonCanonicalExcept(
  db: DB,
  network: string,
  canonicalTxids: string[],
): Promise<void> {
  await db
    .update(chainEvents)
    .set({ canonical: false })
    .where(
      and(
        eq(chainEvents.network, network),
        eq(chainEvents.canonical, true),
        canonicalTxids.length > 0
          ? notInArray(chainEvents.txid, canonicalTxids)
          : undefined,
      ),
    );
}
export async function markMintsNonCanonicalExcept(
  db: DB,
  network: string,
  canonicalTxids: string[],
): Promise<void> {
  await db
    .update(mints)
    .set({ canonical: false })
    .where(
      and(
        eq(mints.network, network),
        eq(mints.canonical, true),
        canonicalTxids.length > 0
          ? notInArray(mints.txid, canonicalTxids)
          : undefined,
      ),
    );
}
export async function markTradesNonCanonicalExcept(
  db: DB,
  network: string,
  canonicalTxids: string[],
): Promise<void> {
  await db
    .update(trades)
    .set({ canonical: false })
    .where(
      and(
        eq(trades.network, network),
        eq(trades.canonical, true),
        canonicalTxids.length > 0
          ? notInArray(trades.txid, canonicalTxids)
          : undefined,
      ),
    );
}
