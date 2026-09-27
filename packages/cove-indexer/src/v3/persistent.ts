import type { CoreRpcProvider } from "@crclaunch/bitcoin";
import type { Database } from "@crclaunch/db";
import { hydrateState } from "./hydrate.js";
import type { V3Store } from "./store.js";
import type { V3IndexerState } from "./state.js";
import type { V3IndexerConfig } from "./types.js";
export function blockExtendsCursor(
  cursor: {
    height: bigint;
    blockHash: string;
  },
  block: {
    height: bigint;
    parentHash: string;
  },
  activationHeight: bigint,
): boolean {
  if (cursor.height === 0n && block.height === activationHeight) return true;
  return (
    block.height === cursor.height + 1n && block.parentHash === cursor.blockHash
  );
}
export async function persistentWorker(params: {
  db: Database;
  store: V3Store;
  state: V3IndexerState;
  provider: CoreRpcProvider;
  config: V3IndexerConfig;
  opts?: {
    rebuilding?: boolean;
  };
}): Promise<{
  indexed: number;
  finalHeight: bigint;
  stateRoot: string;
}> {
  const { db, store, state, provider } = params;
  const rebuilding = params.opts?.rebuilding ?? false;
  const info = await provider.getBlockchainInfo();
  const tip = BigInt(info.blocks);
  let indexed = 0;
  const start =
    state.cursor.height + 1n > params.config.genesisHeight
      ? state.cursor.height + 1n
      : params.config.genesisHeight;
  for (let h = start; h <= tip; h++) {
    const hash = await provider.getBlockHash(Number(h));
    if (state.undoByHeight.get(h)?.blockHash === hash) continue;
    const block = await provider.getBlock(hash);
    const input = {
      height: h,
      hash: block.hash,
      parentHash: block.previousBlockHash,
      txs: block.rawTxs,
    };
    if (!blockExtendsCursor(state.cursor, input, params.config.genesisHeight)) {
      await reorgPersistentToTip({
        db,
        store,
        state,
        provider,
        config: params.config,
      });
      return {
        indexed,
        finalHeight: state.cursor.height,
        stateRoot: state.stateRoot(),
      };
    }
    const staged = state.clone();
    staged.applyBlock(input);
    const undo = staged.undoByHeight.get(h)!;
    const events = staged.events.filter((e) => e.blockHeight === h);
    await db.transaction(async (tx) => {
      await store.persistBlock(tx, staged, input, events, undo, { rebuilding });
    });
    state.adopt(staged);
    indexed += 1;
  }
  return {
    indexed,
    finalHeight: state.cursor.height,
    stateRoot: state.stateRoot(),
  };
}
export async function reorgPersistentToTip(params: {
  db: Database;
  store: V3Store;
  state: V3IndexerState;
  provider: CoreRpcProvider;
  config: V3IndexerConfig;
}): Promise<{
  commonAncestor: bigint;
  orphaned: bigint[];
  replayed: bigint[];
  finalRoot: string;
}> {
  const { db, store, state, provider } = params;
  const tipHeight = BigInt((await provider.getBlockchainInfo()).blocks);
  let ancestor =
    state.cursor.height > tipHeight ? tipHeight : state.cursor.height;
  const floor =
    params.config.genesisHeight > 0n ? params.config.genesisHeight - 1n : 0n;
  if (ancestor < floor) ancestor = floor;
  while (ancestor > floor) {
    const coreHash = await provider.getBlockHash(Number(ancestor));
    const local = state.undoByHeight.get(ancestor);
    if (local && local.blockHash === coreHash) break;
    ancestor -= 1n;
  }
  const orphaned: bigint[] = [];
  for (let h = state.cursor.height; h > ancestor; h--) {
    const undo = state.undoByHeight.get(h)!;
    const staged = state.clone();
    staged.undoBlock(h);
    await db.transaction(async (tx) => {
      await store.rollback(tx, undo, staged.cursor);
    });
    state.adopt(staged);
    orphaned.push(h);
  }
  const replayed: bigint[] = [];
  for (let h = ancestor + 1n; h <= tipHeight; h++) {
    const hash = await provider.getBlockHash(Number(h));
    const block = await provider.getBlock(hash);
    const input = {
      height: h,
      hash: block.hash,
      parentHash: block.previousBlockHash,
      txs: block.rawTxs,
    };
    if (!blockExtendsCursor(state.cursor, input, params.config.genesisHeight)) {
      throw new Error(
        `Core changed branches during reorg replay at height ${h}; retry the worker tick`,
      );
    }
    const staged = state.clone();
    staged.applyBlock(input);
    const undo = staged.undoByHeight.get(h)!;
    const events = staged.events.filter((e) => e.blockHeight === h);
    await db.transaction(async (tx) => {
      await store.persistBlock(tx, staged, input, events, undo, {
        rebuilding: false,
      });
    });
    state.adopt(staged);
    replayed.push(h);
  }
  return {
    commonAncestor: ancestor,
    orphaned,
    replayed,
    finalRoot: state.stateRoot(),
  };
}
export { hydrateState };
