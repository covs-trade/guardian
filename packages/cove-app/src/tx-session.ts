import { eq, and, desc } from "drizzle-orm";
import { schema, type Database } from "@crclaunch/db";
import { AppError } from "./errors.js";
import type { TokenMetadataInput } from "./metadata.js";
export type AppTxOperation =
  "DEPLOY" | "BACKING_BUY" | "REDEEM" | "TRANSFER" | "P2P";
export type AppTxStatus =
  | "BUILT"
  | "WALLET_SIGNED"
  | "BROADCAST"
  | "CONFIRMED"
  | "REORGED"
  | "FAILED"
  | "EXPIRED";
export interface NewTxSession {
  network: string;
  operation: AppTxOperation;
  tokenId: string | null;
  walletScript: string;
  walletAddress: string | null;
  stateHash: string | null;
  backingTxid: string | null;
  backingVout: number | null;
  unsignedTxDigest: string;
  psbtBase64: string | null;
  metadataJson?: TokenMetadataInput | null;
  txid?: string | null;
  status: AppTxStatus;
  expiresAtHeight: bigint | null;
  idempotencyKey: string;
}
export type TxSessionRow = typeof schema.coveV3AppTransactions.$inferSelect;
export type TxSessionPatch = Partial<Omit<NewTxSession, "idempotencyKey">> & {
  errorCode?: string | null;
};
function sameMetadata(
  a: TokenMetadataInput | null | undefined,
  b: TokenMetadataInput | null | undefined,
): boolean {
  if (!a || !b) return !a && !b;
  return (
    a.displayName === b.displayName &&
    a.description === b.description &&
    (a.websiteUrl ?? null) === (b.websiteUrl ?? null) &&
    (a.xUrl ?? null) === (b.xUrl ?? null) &&
    (a.imageUrl ?? null) === (b.imageUrl ?? null)
  );
}
export async function getTxSession(
  db: Database,
  id: string,
): Promise<TxSessionRow | null> {
  const rows = await db
    .select()
    .from(schema.coveV3AppTransactions)
    .where(eq(schema.coveV3AppTransactions.id, id));
  return rows[0] ?? null;
}
export async function requireTxSession(
  db: Database,
  id: string,
): Promise<TxSessionRow> {
  const s = await getTxSession(db, id);
  if (!s)
    throw new AppError("SESSION_NOT_FOUND", "transaction session not found");
  return s;
}
export async function createTxSession(
  db: Database,
  input: NewTxSession,
): Promise<TxSessionRow> {
  const existing = await db
    .select()
    .from(schema.coveV3AppTransactions)
    .where(
      and(
        eq(schema.coveV3AppTransactions.network, input.network),
        eq(schema.coveV3AppTransactions.walletScript, input.walletScript),
        eq(schema.coveV3AppTransactions.operation, input.operation),
        eq(schema.coveV3AppTransactions.idempotencyKey, input.idempotencyKey),
      ),
    );
  if (existing.length > 0) {
    const e = existing[0]!;
    if (
      e.tokenId === input.tokenId &&
      e.unsignedTxDigest === input.unsignedTxDigest &&
      sameMetadata(e.metadataJson, input.metadataJson)
    )
      return e;
    throw new AppError(
      "IDEMPOTENCY_CONFLICT",
      "idempotency key reused with a conflicting payload",
    );
  }
  const rows = await db
    .insert(schema.coveV3AppTransactions)
    .values({ ...input, txid: input.txid ?? null })
    .returning();
  return rows[0]!;
}
export async function updateTxSession(
  db: Database,
  id: string,
  patch: TxSessionPatch,
): Promise<void> {
  await db
    .update(schema.coveV3AppTransactions)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(schema.coveV3AppTransactions.id, id));
}
export async function listTxSessionsByScript(
  db: Database,
  network: string,
  walletScript: string,
  limit = 50,
): Promise<TxSessionRow[]> {
  return db
    .select()
    .from(schema.coveV3AppTransactions)
    .where(
      and(
        eq(schema.coveV3AppTransactions.network, network),
        eq(schema.coveV3AppTransactions.walletScript, walletScript),
      ),
    )
    .orderBy(desc(schema.coveV3AppTransactions.createdAt))
    .limit(limit);
}
export async function listPendingSessions(
  db: Database,
  network: string,
): Promise<TxSessionRow[]> {
  return db
    .select()
    .from(schema.coveV3AppTransactions)
    .where(
      and(
        eq(schema.coveV3AppTransactions.network, network),
        eq(schema.coveV3AppTransactions.status, "BROADCAST"),
      ),
    );
}
export async function findBroadcastSpendOfBacking(
  db: Database,
  network: string,
  tokenId: string,
  backingTxid: string,
  backingVout: number,
): Promise<{
  txid: string | null;
  operation: string;
} | null> {
  const rows = await db
    .select({
      txid: schema.coveV3AppTransactions.txid,
      operation: schema.coveV3AppTransactions.operation,
    })
    .from(schema.coveV3AppTransactions)
    .where(
      and(
        eq(schema.coveV3AppTransactions.network, network),
        eq(schema.coveV3AppTransactions.tokenId, tokenId),
        eq(schema.coveV3AppTransactions.backingTxid, backingTxid),
        eq(schema.coveV3AppTransactions.backingVout, backingVout),
        eq(schema.coveV3AppTransactions.status, "BROADCAST"),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}
