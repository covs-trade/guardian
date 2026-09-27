import type { Sats } from "@crclaunch/curve";
export interface BitcoinTx {
  txid: string;
  hex: string;
  blockHeight: bigint | null;
  confirmations: number;
  status: "MEMPOOL" | "CONFIRMED" | "UNKNOWN";
}
export interface Utxo {
  txid: string;
  vout: number;
  address: string;
  amountSats: Sats;
  confirmations: number;
}
export interface FeeEstimates {
  fastestSatVb: bigint;
  halfHourSatVb: bigint;
  hourSatVb: bigint;
  minimumSatVb: bigint;
}
export interface BitcoinNodeLike {
  getHeight(): Promise<bigint>;
  getBlockHash(height: bigint): Promise<string>;
  getTx(txid: string): Promise<BitcoinTx | null>;
  getUtxos(address: string): Promise<Utxo[]>;
  getFeeEstimates(): Promise<FeeEstimates>;
  submitRawTx(rawTx: string): Promise<string>;
}
export interface BitcoinProvider {
  getHeight(): Promise<bigint>;
  getBlockHash(height: bigint): Promise<string>;
  getTransaction(txid: string): Promise<BitcoinTx>;
  getUtxos(address: string): Promise<Utxo[]>;
  getFeeEstimates(): Promise<FeeEstimates>;
  broadcast(rawTx: string): Promise<string>;
}
