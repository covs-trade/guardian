import type {
  BitcoinNodeLike,
  BitcoinProvider,
  BitcoinTx,
  FeeEstimates,
  Utxo,
} from "./types.js";
export class MockBitcoinProvider implements BitcoinProvider {
  constructor(private readonly node: BitcoinNodeLike) {}
  async getHeight(): Promise<bigint> {
    return this.node.getHeight();
  }
  async getBlockHash(height: bigint): Promise<string> {
    return this.node.getBlockHash(height);
  }
  async getTransaction(txid: string): Promise<BitcoinTx> {
    const tx = await this.node.getTx(txid);
    if (!tx) {
      return {
        txid,
        hex: "",
        blockHeight: null,
        confirmations: 0,
        status: "UNKNOWN",
      };
    }
    return tx;
  }
  async getUtxos(address: string): Promise<Utxo[]> {
    return this.node.getUtxos(address);
  }
  async getFeeEstimates(): Promise<FeeEstimates> {
    return this.node.getFeeEstimates();
  }
  async broadcast(rawTx: string): Promise<string> {
    return this.node.submitRawTx(rawTx);
  }
}
