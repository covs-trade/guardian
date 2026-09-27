import * as bitcoin from "bitcoinjs-lib";
import { decodeRawTransaction, type BitcoinProtocolTx } from "./decoder.js";
export interface BitcoinBlock {
  hash: string;
  height: number;
  previousBlockHash: string;
  txids: string[];
  rawTxs: string[];
}
export interface ChainUtxo {
  txid: string;
  vout: number;
  scriptPubKeyHex: string;
  valueSats: bigint;
  confirmations: number;
  tapInternalKeyHex?: string;
}
export interface BlockchainInfo {
  chain: string;
  blocks: number;
  bestBlockHash: string;
}
export interface BitcoinChainProvider {
  getBestHeight(): Promise<number>;
  getBlockHash(height: number): Promise<string>;
  getBlock(hash: string): Promise<BitcoinBlock>;
  getRawTransaction(txid: string): Promise<string>;
  getBlockchainInfo(): Promise<BlockchainInfo>;
  getTransaction(txid: string): Promise<BitcoinProtocolTx>;
  getPrevout(txid: string, vout: number): Promise<ChainUtxo | undefined>;
  getUtxos(scriptOrAddress: string): Promise<ChainUtxo[]>;
  broadcastTransaction(hex: string): Promise<string>;
  testMempoolAccept(
    hex: string,
    maxFeeRateSatVb?: bigint,
  ): Promise<{
    allowed: boolean;
    rejectReason?: string;
  }>;
  estimateFeeRate(): Promise<bigint>;
  estimateFeeRateAt(blocks: number): Promise<bigint | null>;
  getMempoolMinFeeSatPerVb(): Promise<bigint>;
}
interface RpcConfig {
  url: string;
  user?: string;
  password?: string;
  maxFeeRateSatVb?: bigint;
}
export function btcPerKvbToSatPerVb(btcPerKvb: number): bigint {
  if (!Number.isFinite(btcPerKvb) || btcPerKvb <= 0) return 2n;
  return BigInt(Math.max(1, Math.round(btcPerKvb * 100000)));
}
export function testMempoolAcceptParams(
  hex: string,
  maxfeerateBtcPerKvb?: number,
): unknown[] {
  return maxfeerateBtcPerKvb === undefined
    ? [[hex]]
    : [[hex], maxfeerateBtcPerKvb];
}
export class CoreRpcProvider implements BitcoinChainProvider {
  private id = 0;
  private decodedCache = new Map<string, BitcoinProtocolTx>();
  constructor(private readonly cfg: RpcConfig) {}
  private async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.cfg.user !== undefined) {
      const token = Buffer.from(
        `${this.cfg.user}:${this.cfg.password ?? ""}`,
      ).toString("base64");
      headers.authorization = `Basic ${token}`;
    }
    const res = await fetch(this.cfg.url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "1.0",
        id: `${++this.id}`,
        method,
        params,
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`RPC ${method} HTTP ${res.status}`);
    const json = (await res.json()) as {
      result?: T;
      error?: {
        message?: string;
      } | null;
    };
    if (json.error)
      throw new Error(`RPC ${method}: ${json.error.message ?? "error"}`);
    return json.result as T;
  }
  async getBestHeight(): Promise<number> {
    return this.call<number>("getblockcount");
  }
  async getBlockHash(height: number): Promise<string> {
    return this.call<string>("getblockhash", [height]);
  }
  async getBlockchainInfo(): Promise<BlockchainInfo> {
    const info = await this.call<{
      chain: string;
      blocks: number;
      bestblockhash: string;
    }>("getblockchaininfo");
    return {
      chain: info.chain,
      blocks: info.blocks,
      bestBlockHash: info.bestblockhash,
    };
  }
  async getBlock(hash: string): Promise<BitcoinBlock> {
    const raw = await this.call<string>("getblock", [hash, 0]);
    const header = await this.call<{
      height: number;
      previousblockhash?: string;
    }>("getblockheader", [hash]);
    const block = bitcoin.Block.fromHex(raw);
    if (block.getId() !== hash)
      throw new Error(
        `Block hash mismatch: requested ${hash}, got ${block.getId()}`,
      );
    const transactions = block.transactions ?? [];
    const mutated = { value: false };
    const actualMerkleRoot = bitcoin.Block.calculateMerkleRoot(
      transactions,
      false,
      mutated,
    );
    if (mutated.value || !block.merkleRoot!.equals(actualMerkleRoot)) {
      throw new Error("Block merkle root mismatch.");
    }
    const txids = transactions.map((tx) => tx.getId());
    const rawTxs = transactions.map((tx) => tx.toHex());
    return {
      hash,
      height: header.height,
      previousBlockHash: header.previousblockhash ?? "",
      txids,
      rawTxs,
    };
  }
  async getRawTransaction(txid: string): Promise<string> {
    return this.call<string>("getrawtransaction", [txid, false]);
  }
  private async getDecodedTransaction(
    txid: string,
  ): Promise<BitcoinProtocolTx> {
    const cached = this.decodedCache.get(txid);
    if (cached) return cached;
    const raw = await this.getRawTransaction(txid);
    const tx = decodeRawTransaction(raw);
    if (this.decodedCache.size >= 10000) this.decodedCache.clear();
    this.decodedCache.set(txid, tx);
    return tx;
  }
  async getPrevout(txid: string, vout: number): Promise<ChainUtxo | undefined> {
    const prev = await this.getDecodedTransaction(txid);
    const out = prev.outputs[vout];
    if (!out) return undefined;
    return {
      txid,
      vout,
      scriptPubKeyHex: out.scriptPubKeyHex,
      valueSats: out.valueSats,
      confirmations: 0,
    };
  }
  async getTxout(
    txid: string,
    vout: number,
  ): Promise<{
    scriptPubKeyHex: string;
    valueSats: bigint;
    confirmations: number;
  } | null> {
    const res = await this.call<{
      scriptPubKey?: {
        hex: string;
      };
      value?: number;
      confirmations?: number;
    } | null>("gettxout", [txid, vout]);
    if (!res || !res.scriptPubKey || typeof res.value !== "number") return null;
    return {
      scriptPubKeyHex: res.scriptPubKey.hex,
      valueSats: BigInt(Math.round(res.value * 1e8)),
      confirmations: res.confirmations ?? 0,
    };
  }
  async getTransaction(txid: string): Promise<BitcoinProtocolTx> {
    const tx = await this.getDecodedTransaction(txid);
    for (const input of tx.inputs) {
      if (input.prevTxid === "0".repeat(64)) continue;
      const prevOut = await this.getPrevout(input.prevTxid, input.vout);
      if (prevOut) {
        input.prevScriptPubKeyHex = prevOut.scriptPubKeyHex;
        input.prevValueSats = prevOut.valueSats;
      }
    }
    return tx;
  }
  async getUtxos(): Promise<ChainUtxo[]> {
    return [];
  }
  async broadcastTransaction(hex: string): Promise<string> {
    const maxfeerate = this.cfg.maxFeeRateSatVb
      ? Number(this.cfg.maxFeeRateSatVb) / 100000
      : undefined;
    return this.call<string>(
      "sendrawtransaction",
      maxfeerate === undefined ? [hex] : [hex, maxfeerate],
    );
  }
  async testMempoolAccept(
    hex: string,
    maxFeeRateSatVb?: bigint,
  ): Promise<{
    allowed: boolean;
    rejectReason?: string;
  }> {
    const maxfeerate =
      maxFeeRateSatVb !== undefined
        ? Number(maxFeeRateSatVb) / 100000
        : this.cfg.maxFeeRateSatVb
          ? Number(this.cfg.maxFeeRateSatVb) / 100000
          : undefined;
    const res = await this.call<
      {
        allowed: boolean;
        "reject-reason"?: string;
      }[]
    >("testmempoolaccept", testMempoolAcceptParams(hex, maxfeerate));
    const r = res?.[0];
    if (!r) return { allowed: false, rejectReason: "no result" };
    return { allowed: r.allowed, rejectReason: r["reject-reason"] };
  }
  async estimateFeeRate(): Promise<bigint> {
    const res = await this.call<{
      feerate?: number;
      errors?: string[];
    }>("estimatesmartfee", [2]);
    const btcPerKvb = res?.feerate;
    let rate: bigint;
    if (
      typeof btcPerKvb !== "number" ||
      !Number.isFinite(btcPerKvb) ||
      btcPerKvb <= 0
    ) {
      rate = 2n;
    } else {
      rate = btcPerKvbToSatPerVb(btcPerKvb);
    }
    if (this.cfg.maxFeeRateSatVb && rate > this.cfg.maxFeeRateSatVb) {
      return this.cfg.maxFeeRateSatVb;
    }
    return rate;
  }
  async estimateFeeRateAt(blocks: number): Promise<bigint | null> {
    const res = await this.call<{
      feerate?: number;
      errors?: string[];
    }>("estimatesmartfee", [blocks]);
    const btcPerKvb = res?.feerate;
    if (
      typeof btcPerKvb !== "number" ||
      !Number.isFinite(btcPerKvb) ||
      btcPerKvb <= 0
    )
      return null;
    const rate = btcPerKvbToSatPerVb(btcPerKvb);
    if (this.cfg.maxFeeRateSatVb && rate > this.cfg.maxFeeRateSatVb) {
      return this.cfg.maxFeeRateSatVb;
    }
    return rate;
  }
  async getMempoolMinFeeSatPerVb(): Promise<bigint> {
    const info = await this.call<{
      mempoolminfee?: number;
      minrelaytxfee?: number;
    }>("getmempoolinfo");
    const btcPerKvb = Math.max(
      info?.mempoolminfee ?? 0,
      info?.minrelaytxfee ?? 0,
    );
    if (!Number.isFinite(btcPerKvb) || btcPerKvb <= 0) return 1n;
    return BigInt(Math.max(1, Math.ceil(btcPerKvb * 100000)));
  }
}
