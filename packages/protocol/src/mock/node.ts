import type { Network } from "@crclaunch/config";
import type { Sats } from "@crclaunch/curve";
import type { BitcoinTx, FeeEstimates, Utxo } from "@crclaunch/bitcoin";
import type {
  MockBlock,
  MockChainState,
  MockEvent,
  MockListing,
  MockToken,
  MockTx,
} from "./types.js";
import {
  createInitialState,
  getConfirmedEvents,
  getStateHash,
  MOCK_FAUCET_SATS,
  mineBlock,
  reorg,
} from "./chain.js";
import { deserializeState, serializeState } from "./serialize.js";
import { isMockSignedPsbt, parseSignedMockPsbt } from "./envelope.js";
import type { MockStorage } from "./store.js";
import type { ProtocolConfig } from "../validation/config.js";
import { DEFAULT_MOCK_PROTOCOL_CONFIG } from "../validation/config.js";
export interface MockHealth {
  synced: boolean;
  stateValid: boolean;
  lagBlocks: bigint;
}
export class MockChainNode {
  private state: MockChainState;
  private initialized = false;
  constructor(
    private readonly storage: MockStorage,
    private readonly network: Network = "mock",
    private readonly config: ProtocolConfig = DEFAULT_MOCK_PROTOCOL_CONFIG,
  ) {
    this.state = createInitialState(network, config);
  }
  private migrateState(state: MockChainState): MockChainState {
    if (!state.config) {
      state.config = this.config;
    }
    return state;
  }
  async init(): Promise<void> {
    if (this.initialized) return;
    const json = await this.storage.read();
    if (json) {
      this.state = this.migrateState(deserializeState<MockChainState>(json));
    } else {
      await this.persist();
    }
    this.initialized = true;
  }
  get snapshot(): MockChainState {
    return this.state;
  }
  async mutate<T>(fn: (s: MockChainState) => T): Promise<T> {
    await this.init();
    const release = await this.storage.lock();
    try {
      const json = await this.storage.read();
      if (json)
        this.state = this.migrateState(deserializeState<MockChainState>(json));
      const result = fn(this.state);
      await this.persist();
      return result;
    } finally {
      await release();
    }
  }
  private async persist(): Promise<void> {
    await this.storage.write(serializeState(this.state));
  }
  private async refresh(): Promise<void> {
    await this.init();
    const json = await this.storage.read();
    if (json)
      this.state = this.migrateState(deserializeState<MockChainState>(json));
  }
  async getHeight(): Promise<bigint> {
    await this.refresh();
    return this.state.height;
  }
  async getBlockHash(height: bigint): Promise<string> {
    await this.refresh();
    const block = this.state.blocks.find((b) => b.height === height);
    return block?.hash ?? `mock-block-hash-${height}`;
  }
  async getTx(txid: string): Promise<BitcoinTx | null> {
    await this.refresh();
    const tx = this.state.txs[txid];
    if (!tx) return null;
    const confirmations =
      tx.confirmHeight !== null
        ? Number(this.state.height - tx.confirmHeight + 1n)
        : 0;
    return {
      txid: tx.txid,
      hex: serializeState(tx),
      blockHeight: tx.confirmHeight,
      confirmations,
      status:
        tx.status === "CONFIRMED"
          ? "CONFIRMED"
          : tx.status === "MEMPOOL"
            ? "MEMPOOL"
            : "UNKNOWN",
    };
  }
  async getMockTx(txid: string): Promise<MockTx | null> {
    await this.refresh();
    return this.state.txs[txid] ?? null;
  }
  async getUtxos(address: string): Promise<Utxo[]> {
    await this.refresh();
    const bal = this.state.balances[address];
    const btcSats = bal ? bal.btcSats : MOCK_FAUCET_SATS;
    if (btcSats <= 0n) return [];
    return [
      {
        txid: `mock-utxo-${address}`,
        vout: 0,
        address,
        amountSats: btcSats,
        confirmations: 6,
      },
    ];
  }
  async getFeeEstimates(): Promise<FeeEstimates> {
    return {
      fastestSatVb: 3n,
      halfHourSatVb: 2n,
      hourSatVb: 1n,
      minimumSatVb: 1n,
    };
  }
  async submitRawTx(rawTx: string): Promise<string> {
    return this.mutate((state) => {
      if (!isMockSignedPsbt(rawTx)) {
        throw new Error("MOCK_TX_NOT_SIGNED");
      }
      const { envelope, signer } = parseSignedMockPsbt(rawTx);
      if (!signer) throw new Error("MOCK_TX_NO_SIGNER");
      const existing = state.txs[envelope.txid];
      if (existing) return existing.txid;
      const tx: MockTx = {
        ...envelope,
        signer,
        signature: "mock",
        status: "MEMPOOL",
        confirmHeight: null,
        rejectReason: null,
      };
      state.txs[envelope.txid] = tx;
      state.mempool.push(envelope.txid);
      return envelope.txid;
    });
  }
  async getStateHash(): Promise<string> {
    await this.refresh();
    return getStateHash(this.state);
  }
  async getHealth(): Promise<MockHealth> {
    await this.refresh();
    return { synced: true, stateValid: true, lagBlocks: 0n };
  }
  async getTokenByTicker(ticker: string): Promise<MockToken | null> {
    await this.refresh();
    const id = this.state.tickerIndex[ticker.toUpperCase()];
    return id ? (this.state.tokens[id] ?? null) : null;
  }
  async getTokenByDeployment(txid: string): Promise<MockToken | null> {
    await this.refresh();
    return this.state.tokens[txid] ?? null;
  }
  async getAllTokens(): Promise<MockToken[]> {
    await this.refresh();
    return Object.values(this.state.tokens);
  }
  async getListings(): Promise<MockListing[]> {
    await this.refresh();
    return Object.values(this.state.listings);
  }
  async getListing(id: string): Promise<MockListing | null> {
    await this.refresh();
    return this.state.listings[id] ?? null;
  }
  async getEvents(from: bigint, to: bigint): Promise<MockEvent[]> {
    await this.refresh();
    return getConfirmedEvents(this.state).filter(
      (e) => e.blockHeight >= from && e.blockHeight <= to,
    );
  }
  async getBlocks(): Promise<MockBlock[]> {
    await this.refresh();
    return [...this.state.blocks];
  }
  async getCanonicalTxids(): Promise<string[]> {
    await this.refresh();
    return this.state.blocks.flatMap((b) => b.txids);
  }
  async mineBlock(): Promise<MockBlock> {
    return this.mutate((state) => mineBlock(state));
  }
  async reorg(depth: number): Promise<MockBlock[]> {
    return this.mutate((state) => reorg(state, depth));
  }
  async getWalletBalance(address: string): Promise<{
    btcSats: Sats;
    tokens: Record<string, bigint>;
    lockedTokens: Record<string, bigint>;
  }> {
    await this.refresh();
    const bal = this.state.balances[address];
    if (!bal)
      return { btcSats: MOCK_FAUCET_SATS, tokens: {}, lockedTokens: {} };
    return {
      btcSats: bal.btcSats,
      tokens: { ...bal.tokens },
      lockedTokens: { ...bal.lockedTokens },
    };
  }
  async getAllBalances(): Promise<
    {
      address: string;
      btcSats: Sats;
      tokens: Record<string, bigint>;
      lockedTokens: Record<string, bigint>;
    }[]
  > {
    await this.refresh();
    return Object.entries(this.state.balances).map(([address, bal]) => ({
      address,
      btcSats: bal.btcSats,
      tokens: { ...bal.tokens },
      lockedTokens: { ...bal.lockedTokens },
    }));
  }
}
