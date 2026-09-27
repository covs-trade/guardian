import type { V3Backing, V3TokenMeta, V3TokenUtxo } from "./types.js";
export function balanceByScript(
  tokenUtxos: Iterable<V3TokenUtxo>,
  tokenId: string,
  scriptPubKey: string,
): bigint {
  let sum = 0n;
  for (const u of tokenUtxos) {
    if (u.tokenId === tokenId && u.scriptPubKey === scriptPubKey)
      sum += u.amountAtoms;
  }
  return sum;
}
export function tokenUtxosByScript(
  tokenUtxos: Iterable<V3TokenUtxo>,
  scriptPubKey: string,
): V3TokenUtxo[] {
  return [...tokenUtxos].filter((u) => u.scriptPubKey === scriptPubKey);
}
export function tokenHolders(
  tokenUtxos: Iterable<V3TokenUtxo>,
  tokenId: string,
): {
  scriptPubKey: string;
  amountAtoms: bigint;
}[] {
  const m = new Map<string, bigint>();
  for (const u of tokenUtxos) {
    if (u.tokenId !== tokenId) continue;
    m.set(u.scriptPubKey, (m.get(u.scriptPubKey) ?? 0n) + u.amountAtoms);
  }
  return [...m.entries()].map(([scriptPubKey, amountAtoms]) => ({
    scriptPubKey,
    amountAtoms,
  }));
}
export interface TokenDetail {
  tokenId: string;
  ticker: string;
  deployTxid: string;
  policyVersion: number;
  issuedSupplyAtoms: bigint;
  publicCapAtoms: bigint;
  backingSats: bigint;
  backingOutpoint: {
    txid: string;
    vout: number;
  };
  backingStateHash: string;
  curveStage: number;
  holderCount: number;
  tokenUtxoCount: number;
  deployHeight: bigint;
}
export function currentBacking(
  token: V3TokenMeta,
  backing: V3Backing,
  tokenUtxos: Iterable<V3TokenUtxo>,
  publicCapAtoms: bigint,
): TokenDetail {
  const holders = tokenHolders(tokenUtxos, token.tokenId);
  const utxoCount = [...tokenUtxos].filter(
    (u) => u.tokenId === token.tokenId,
  ).length;
  return {
    tokenId: token.tokenId,
    ticker: token.ticker,
    deployTxid: token.deployTxid,
    policyVersion: token.policyVersion,
    issuedSupplyAtoms: backing.state.issuedPublicSupplyAtoms,
    publicCapAtoms,
    backingSats: backing.state.backingSats,
    backingOutpoint: backing.outpoint,
    backingStateHash: backing.stateHash,
    curveStage: backing.state.curveStage,
    holderCount: holders.length,
    tokenUtxoCount: utxoCount,
    deployHeight: token.deployHeight,
  };
}
export function tokenActivity(
  events: {
    txid: string;
    tokenId: string | null;
    blockHeight: bigint;
    txIndex: number;
    operation: string | null;
    valid: boolean;
    reason: string | null;
  }[],
  tokenId: string,
) {
  return events.filter((e) => e.tokenId === tokenId && e.operation !== null);
}
