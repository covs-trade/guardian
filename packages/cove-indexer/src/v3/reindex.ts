import { eq } from "drizzle-orm";
import { schema, type Database } from "@crclaunch/db";
import type { CoreRpcProvider } from "@crclaunch/bitcoin";
import { V3IndexerState } from "./state.js";
import type { V3Store } from "./store.js";
import { persistentWorker } from "./persistent.js";
import { computeStateRootFromDb } from "./hydrate.js";
import { quickVerify, fullVerify } from "./verify.js";
import type { V3IndexerConfig } from "./types.js";
export async function reindexDb(params: {
  db: Database;
  store: V3Store;
  provider: CoreRpcProvider;
  config: V3IndexerConfig;
  network: string;
}): Promise<{
  finalHeight: bigint;
  stateRoot: string;
}> {
  const { db, store, provider, config, network } = params;
  await db.transaction(async (tx) => {
    await tx
      .insert(schema.coveV3Cursor)
      .values({
        network,
        height: 0n,
        blockHash: "",
        stateRoot: "",
        rebuilding: true,
      })
      .onConflictDoUpdate({
        target: schema.coveV3Cursor.network,
        set: { rebuilding: true, height: 0n, blockHash: "", stateRoot: "" },
      });
  });
  await db.transaction(async (tx) => {
    await tx
      .delete(schema.coveV3Events)
      .where(eq(schema.coveV3Events.network, network));
    await tx
      .delete(schema.coveV3Undo)
      .where(eq(schema.coveV3Undo.network, network));
    await tx
      .delete(schema.coveV3TokenUtxos)
      .where(eq(schema.coveV3TokenUtxos.network, network));
    await tx
      .delete(schema.coveV3BackingStates)
      .where(eq(schema.coveV3BackingStates.network, network));
    await tx
      .delete(schema.coveV3Tokens)
      .where(eq(schema.coveV3Tokens.network, network));
    await tx
      .delete(schema.coveV3Blocks)
      .where(eq(schema.coveV3Blocks.network, network));
  });
  const state = new V3IndexerState(config);
  const result = await persistentWorker({
    db,
    store,
    state,
    provider,
    config,
    opts: { rebuilding: true },
  });
  const dbRoot = await computeStateRootFromDb(db, network, config);
  if (dbRoot !== result.stateRoot) {
    throw new Error(
      `REINDEX_VERIFY_FAILED: db root ${dbRoot} != worker root ${result.stateRoot}`,
    );
  }
  const quick = await quickVerify(state, provider);
  if (!quick.ok)
    throw new Error(`REINDEX_VERIFY_FAILED: quick ${quick.reason}`);
  const full = await fullVerify(state, provider, config);
  if (!full.ok) throw new Error(`REINDEX_VERIFY_FAILED: full ${full.reason}`);
  await db.transaction(async (tx) => {
    await tx
      .update(schema.coveV3Cursor)
      .set({
        rebuilding: false,
        stateRoot: result.stateRoot,
        height: result.finalHeight,
        blockHash: state.cursor.blockHash,
      })
      .where(eq(schema.coveV3Cursor.network, network));
  });
  return result;
}
