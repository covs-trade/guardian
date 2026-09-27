import { eq, and, isNull } from "drizzle-orm";
import { schema, type Database } from "@crclaunch/db";
import { validateStateV2, type CoveStateV2 } from "@crclaunch/cove-covenant";
import { V3IndexerState } from "./state.js";
import { computeStateRoot } from "./root.js";
import { decodeUndo } from "./undo.js";
import type {
  V3Backing,
  V3Event,
  V3IndexerConfig,
  V3TokenMeta,
  V3TokenUtxo,
} from "./types.js";
function fail(msg: string): never {
  throw new Error(`HYDRATION_FAILED: ${msg}`);
}
export async function hydrateState(
  db: Database,
  network: string,
  config: V3IndexerConfig,
): Promise<V3IndexerState> {
  const state = new V3IndexerState(config);
  const tokens = await db
    .select()
    .from(schema.coveV3Tokens)
    .where(
      and(
        eq(schema.coveV3Tokens.network, network),
        eq(schema.coveV3Tokens.canonical, true),
      ),
    );
  const seenTokens = new Set<string>();
  for (const t of tokens) {
    if (seenTokens.has(t.tokenId)) fail(`duplicate tokenId ${t.tokenId}`);
    seenTokens.add(t.tokenId);
    const meta: V3TokenMeta = {
      tokenId: t.tokenId,
      ticker: t.ticker,
      policyVersion: t.policyVersion,
      tokenNonce: t.nonce,
      deployTxid: t.deployTxid,
      deployHeight: t.deployHeight,
      deployBlockHash: t.deployBlockHash,
      creatorScript: t.creatorScript,
    };
    state.tokens.set(t.tokenId, meta);
  }
  const backings = await db
    .select()
    .from(schema.coveV3BackingStates)
    .where(
      and(
        eq(schema.coveV3BackingStates.network, network),
        eq(schema.coveV3BackingStates.canonical, true),
      ),
    );
  for (const b of backings) {
    if (!state.tokens.has(b.tokenId))
      fail(`backing without token ${b.tokenId}`);
    const stateV2: CoveStateV2 = {
      stateVersion: b.stateVersion as 2,
      policyVersion: b.policyVersion,
      tokenId: b.tokenId,
      issuedPublicSupplyAtoms: b.issuedSupplyAtoms,
      backingSats: b.backingSats,
      curveStage: b.curveStage,
    };
    try {
      validateStateV2(stateV2);
    } catch (e) {
      fail(`backing R(s) mismatch for ${b.tokenId}: ${(e as Error).message}`);
    }
    const outpoint = { txid: b.txid, vout: b.vout };
    const backing: V3Backing = {
      tokenId: b.tokenId,
      state: stateV2,
      stateHash: b.stateHash,
      outpoint,
      scriptPubKey: b.scriptPubKey,
      btcValue: b.btcValue,
      updatedTxid: b.txid,
      updatedHeight: b.blockHeight,
      updatedBlockHash: b.blockHash,
    };
    if (state.backing.has(b.tokenId)) fail(`duplicate backing ${b.tokenId}`);
    state.backing.set(b.tokenId, backing);
  }
  for (const t of state.tokens.keys()) {
    if (!state.backing.has(t)) fail(`missing backing for token ${t}`);
  }
  const utxos = await db
    .select()
    .from(schema.coveV3TokenUtxos)
    .where(
      and(
        eq(schema.coveV3TokenUtxos.network, network),
        eq(schema.coveV3TokenUtxos.canonical, true),
        isNull(schema.coveV3TokenUtxos.spentByTxid),
      ),
    );
  const seenOutpoints = new Set<string>();
  for (const u of utxos) {
    const key = `${u.txid}:${u.vout}`;
    if (seenOutpoints.has(key)) fail(`duplicate outpoint ${key}`);
    seenOutpoints.add(key);
    if (!state.tokens.has(u.tokenId))
      fail(`utxo for unknown token ${u.tokenId}`);
    const utxo: V3TokenUtxo = {
      txid: u.txid,
      vout: u.vout,
      tokenId: u.tokenId,
      amountAtoms: u.amountAtoms,
      scriptPubKey: u.scriptPubKey,
      createdHeight: u.createdHeight,
      createdBlockHash: u.createdBlockHash,
    };
    state.tokenUtxos.set(key, utxo);
  }
  const events = await db
    .select()
    .from(schema.coveV3Events)
    .where(
      and(
        eq(schema.coveV3Events.network, network),
        eq(schema.coveV3Events.canonical, true),
      ),
    );
  state.events.push(
    ...events.map((e) => ({
      txid: e.txid,
      blockHeight: e.blockHeight,
      blockHash: e.blockHash,
      txIndex: e.txIndex,
      operation: e.operation as V3Event["operation"],
      valid: e.valid,
      reason: e.reason,
      tokenId: e.tokenId,
    })),
  );
  const undos = await db
    .select()
    .from(schema.coveV3Undo)
    .where(eq(schema.coveV3Undo.network, network));
  for (const u of undos) {
    const decoded = decodeUndo(u.undoJson);
    state.undoByHeight.set(decoded.height, decoded);
  }
  const cursor = await db
    .select()
    .from(schema.coveV3Cursor)
    .where(eq(schema.coveV3Cursor.network, network));
  if (cursor.length > 1) fail("multiple cursors");
  if (cursor.length === 1) {
    const c = cursor[0]!;
    if (!/^[0-9a-f]{64}$/.test(c.blockHash) && c.height !== 0n)
      fail("malformed cursor blockHash");
    state.cursor = {
      network,
      height: c.height,
      blockHash: c.blockHash,
      stateRoot: c.stateRoot,
    };
  }
  return state;
}
export async function computeStateRootFromDb(
  db: Database,
  network: string,
  config: V3IndexerConfig,
): Promise<string> {
  const state = await hydrateState(db, network, config);
  return computeStateRoot({
    tokens: state.tokens,
    backing: state.backing,
    tokenUtxos: state.tokenUtxos,
  });
}
