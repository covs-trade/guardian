import type { CoreRpcProvider } from "@crclaunch/bitcoin";
import type { V3IndexerState } from "./state.js";
import type { V3IndexerConfig } from "./types.js";
export interface IndexProgress {
  indexedBlocks: number;
  finalHeight: bigint;
  stateRoot: string;
}
export async function indexBlocks(
  state: V3IndexerState,
  provider: CoreRpcProvider,
  config: V3IndexerConfig,
  opts: {
    onBlock?: (height: bigint) => Promise<void> | void;
  } = {},
): Promise<IndexProgress> {
  const info = await provider.getBlockchainInfo();
  const tip = BigInt(info.blocks);
  let indexed = 0;
  for (let h = state.cursor.height + 1n; h <= tip; h++) {
    const hash = await provider.getBlockHash(Number(h));
    const existing = state.undoByHeight.get(h);
    if (existing && existing.blockHash === hash) continue;
    const block = await provider.getBlock(hash);
    state.applyBlock({
      height: h,
      hash: block.hash,
      parentHash: block.previousBlockHash,
      txs: block.rawTxs,
    });
    indexed += 1;
    await opts.onBlock?.(h);
  }
  void config;
  return {
    indexedBlocks: indexed,
    finalHeight: state.cursor.height,
    stateRoot: state.stateRoot(),
  };
}
