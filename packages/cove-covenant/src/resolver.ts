import type { CoveStateV2 } from "./stateV2.js";
export interface OutPoint {
  txid: string;
  vout: number;
}
export interface TokenUtxo {
  outpoint: OutPoint;
  tokenId: Buffer;
  amountAtoms: bigint;
  scriptPubKey: Buffer;
}
export interface TokenMeta {
  tokenId: Buffer;
  ticker: string;
  policyVersion: number;
  deployTxid: string;
  tokenNonce: Buffer;
  creatorScript?: Buffer;
}
export interface BackingView {
  state: CoveStateV2;
  outpoint: OutPoint;
}
export interface CoveCanonicalView {
  readonly cursorHeight?: bigint;
  getBackingStateByOutpoint(outpoint: OutPoint): CoveStateV2 | null;
  getCurrentBackingState(tokenId: Buffer): CoveStateV2 | null;
  getBackingOutpoint(tokenId: Buffer): OutPoint | null;
  getTokenUtxo(outpoint: OutPoint): TokenUtxo | null;
  getTokenCreatorScript?(tokenId: Buffer): Buffer | null;
}
function opKey(o: OutPoint): string {
  return `${o.txid}:${o.vout}`;
}
export class CoveChainView {
  readonly tokens = new Map<string, TokenMeta>();
  readonly tokenUtxos = new Map<string, TokenUtxo>();
  readonly backing = new Map<string, BackingView>();
  deploy(meta: TokenMeta, backingOutpoint: OutPoint, s0: CoveStateV2): void {
    const key = meta.tokenId.toString("hex");
    if (this.tokens.has(key)) throw new Error("duplicate tokenId deploy");
    this.tokens.set(key, meta);
    this.backing.set(key, { state: s0, outpoint: backingOutpoint });
  }
  mint(params: {
    tokenId: Buffer;
    nextState: CoveStateV2;
    prevBackingOutpoint: OutPoint;
    nextBackingOutpoint: OutPoint;
    recipientOutpoint: OutPoint;
    recipientScript: Buffer;
    amountAtoms: bigint;
  }): void {
    const key = params.tokenId.toString("hex");
    if (!this.tokens.has(key)) throw new Error("token not found");
    const b = this.backing.get(key)!;
    if (opKey(b.outpoint) !== opKey(params.prevBackingOutpoint))
      throw new Error("stale backing outpoint");
    this.backing.set(key, {
      state: params.nextState,
      outpoint: params.nextBackingOutpoint,
    });
    this.tokenUtxos.set(opKey(params.recipientOutpoint), {
      outpoint: params.recipientOutpoint,
      tokenId: params.tokenId,
      amountAtoms: params.amountAtoms,
      scriptPubKey: params.recipientScript,
    });
  }
  transfer(params: {
    tokenId: Buffer;
    spentOutpoints: OutPoint[];
    created: {
      outpoint: OutPoint;
      script: Buffer;
      amountAtoms: bigint;
    }[];
  }): void {
    const key = params.tokenId.toString("hex");
    if (!this.tokens.has(key)) throw new Error("token not found");
    for (const o of params.spentOutpoints) {
      const u = this.tokenUtxos.get(opKey(o));
      if (!u) throw new Error(`token input ${opKey(o)} not in canonical set`);
      if (!u.tokenId.equals(params.tokenId))
        throw new Error("mixed token input");
      this.tokenUtxos.delete(opKey(o));
    }
    for (const c of params.created) {
      this.tokenUtxos.set(opKey(c.outpoint), {
        outpoint: c.outpoint,
        tokenId: params.tokenId,
        amountAtoms: c.amountAtoms,
        scriptPubKey: c.script,
      });
    }
  }
  redeem(params: {
    tokenId: Buffer;
    nextState: CoveStateV2;
    prevBackingOutpoint: OutPoint;
    nextBackingOutpoint: OutPoint;
    spentTokenOutpoints: OutPoint[];
    change: {
      outpoint: OutPoint;
      script: Buffer;
      amountAtoms: bigint;
    }[];
  }): void {
    const key = params.tokenId.toString("hex");
    if (!this.tokens.has(key)) throw new Error("token not found");
    const b = this.backing.get(key)!;
    if (opKey(b.outpoint) !== opKey(params.prevBackingOutpoint))
      throw new Error("stale backing outpoint");
    this.backing.set(key, {
      state: params.nextState,
      outpoint: params.nextBackingOutpoint,
    });
    for (const o of params.spentTokenOutpoints) {
      const u = this.tokenUtxos.get(opKey(o));
      if (!u) throw new Error(`token input ${opKey(o)} not in canonical set`);
      if (!u.tokenId.equals(params.tokenId))
        throw new Error("mixed token input");
      this.tokenUtxos.delete(opKey(o));
    }
    for (const c of params.change) {
      this.tokenUtxos.set(opKey(c.outpoint), {
        outpoint: c.outpoint,
        tokenId: params.tokenId,
        amountAtoms: c.amountAtoms,
        scriptPubKey: c.script,
      });
    }
  }
  getCurrentBackingState(tokenId: Buffer): CoveStateV2 | null {
    return this.backing.get(tokenId.toString("hex"))?.state ?? null;
  }
  getBackingOutpoint(tokenId: Buffer): OutPoint | null {
    return this.backing.get(tokenId.toString("hex"))?.outpoint ?? null;
  }
  getBackingStateByOutpoint(o: OutPoint): CoveStateV2 | null {
    for (const b of this.backing.values()) {
      if (opKey(b.outpoint) === opKey(o)) return b.state;
    }
    return null;
  }
  getTokenCreatorScript(tokenId: Buffer): Buffer | null {
    return this.tokens.get(tokenId.toString("hex"))?.creatorScript ?? null;
  }
  getTokenUtxo(o: OutPoint): TokenUtxo | null {
    return this.tokenUtxos.get(opKey(o)) ?? null;
  }
  resolveTokenInputs(
    ins: {
      txid: string;
      vout: number;
    }[],
  ): TokenUtxo[] {
    const out: TokenUtxo[] = [];
    for (const i of ins) {
      const u = this.tokenUtxos.get(opKey(i));
      if (u) out.push(u);
    }
    return out;
  }
  balanceOf(tokenId: Buffer): bigint {
    let total = 0n;
    for (const u of this.tokenUtxos.values()) {
      if (u.tokenId.equals(tokenId)) total += u.amountAtoms;
    }
    return total;
  }
}
