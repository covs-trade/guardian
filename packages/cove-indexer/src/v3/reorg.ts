import type { CoreRpcProvider } from "@crclaunch/bitcoin";
import type { V3IndexerState } from "./state.js";
import type { V3IndexerConfig } from "./types.js";
export interface ReorgReport {
  commonAncestor: bigint;
  orphanedBlocks: bigint[];
  replayedBlocks: bigint[];
  finalRoot: string;
}
export async function reorgToTip(
  state: V3IndexerState,
  provider: CoreRpcProvider,
  config: V3IndexerConfig,
): Promise<ReorgReport> {
  const tipHeight = BigInt((await provider.getBlockchainInfo()).blocks);
  let ancestor = state.cursor.height;
  while (ancestor > 0n) {
    const coreHash = await provider.getBlockHash(Number(ancestor));
    const local = state.undoByHeight.get(ancestor);
    if (local && local.blockHash === coreHash) break;
    ancestor -= 1n;
  }
  const orphaned: bigint[] = [];
  for (let h = state.cursor.height; h > ancestor; h--) {
    state.undoBlock(h);
    orphaned.push(h);
  }
  const replayed: bigint[] = [];
  for (let h = ancestor + 1n; h <= tipHeight; h++) {
    const hash = await provider.getBlockHash(Number(h));
    const block = await provider.getBlock(hash);
    state.applyBlock({
      height: h,
      hash: block.hash,
      parentHash: block.previousBlockHash,
      txs: block.rawTxs,
    });
    replayed.push(h);
  }
  void config;
  return {
    commonAncestor: ancestor,
    orphanedBlocks: orphaned,
    replayedBlocks: replayed,
    finalRoot: state.stateRoot(),
  };
}
