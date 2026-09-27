import type {
  CoveCanonicalView,
  CoveStateV2,
  OutPoint,
  TokenUtxo,
} from "@crclaunch/cove-covenant";
import type { V3IndexerState } from "./state.js";
export interface CanonicalViewSnapshot extends CoveCanonicalView {
  readonly cursorHeight: bigint;
  readonly cursorBlockHash: string;
  readonly rebuilding: boolean;
}
function opKey(o: OutPoint): string {
  return `${o.txid}:${o.vout}`;
}
export function loadCanonicalViewSnapshot(params: {
  state: V3IndexerState;
  relevantOutpoints?: OutPoint[];
}): CanonicalViewSnapshot {
  const { state, relevantOutpoints = [] } = params;
  const wanted = new Set(relevantOutpoints.map(opKey));
  const backingByOutpoint = new Map<string, CoveStateV2>();
  for (const b of state.backing.values())
    backingByOutpoint.set(opKey(b.outpoint), b.state);
  const backingByToken = new Map<string, CoveStateV2>();
  const backingOutpointByToken = new Map<string, OutPoint>();
  for (const [tokenId, b] of state.backing) {
    backingByToken.set(tokenId, b.state);
    backingOutpointByToken.set(tokenId, b.outpoint);
  }
  const utxoByOutpoint = new Map<string, TokenUtxo>();
  for (const u of state.tokenUtxos.values()) {
    if (
      wanted.size === 0 ||
      wanted.has(opKey({ txid: u.txid, vout: u.vout }))
    ) {
      utxoByOutpoint.set(opKey({ txid: u.txid, vout: u.vout }), {
        outpoint: { txid: u.txid, vout: u.vout },
        tokenId: Buffer.from(u.tokenId, "hex"),
        amountAtoms: u.amountAtoms,
        scriptPubKey: Buffer.from(u.scriptPubKey, "hex"),
      });
    }
  }
  return Object.freeze({
    cursorHeight: state.cursor.height,
    cursorBlockHash: state.cursor.blockHash,
    rebuilding: false,
    getBackingStateByOutpoint(o: OutPoint) {
      return backingByOutpoint.get(opKey(o)) ?? null;
    },
    getCurrentBackingState(tokenId: Buffer) {
      return backingByToken.get(tokenId.toString("hex")) ?? null;
    },
    getBackingOutpoint(tokenId: Buffer) {
      return backingOutpointByToken.get(tokenId.toString("hex")) ?? null;
    },
    getTokenCreatorScript(tokenId: Buffer) {
      const c = state.tokens.get(tokenId.toString("hex"))?.creatorScript;
      return c ? Buffer.from(c, "hex") : null;
    },
    getTokenUtxo(o: OutPoint) {
      return utxoByOutpoint.get(opKey(o)) ?? null;
    },
  });
}
