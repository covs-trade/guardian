import * as bitcoin from "bitcoinjs-lib";
export type NetworkName =
  "signet" | "mutinynet" | "testnet4" | "testnet" | "regtest" | "mainnet";
export function btcNetwork(name: NetworkName): bitcoin.networks.Network {
  switch (name) {
    case "mainnet":
      return bitcoin.networks.bitcoin;
    case "regtest":
      return bitcoin.networks.regtest;
    case "signet":
    case "mutinynet":
    case "testnet4":
    case "testnet":
      return bitcoin.networks.testnet;
    default:
      throw new Error(`Unknown Bitcoin network "${String(name)}"`);
  }
}
export { bitcoin };
export interface DecodedInput {
  prevTxid: string;
  vout: number;
  sequence: number;
  prevScriptPubKeyHex?: string;
  prevValueSats?: bigint;
}
export interface DecodedOutput {
  index: number;
  scriptPubKeyHex: string;
  valueSats: bigint;
  address?: string;
  opReturnData?: Uint8Array;
}
export interface BitcoinProtocolTx {
  txid: string;
  version: number;
  locktime: number;
  inputs: DecodedInput[];
  outputs: DecodedOutput[];
}
export function outputAddress(
  script: Buffer,
  network: bitcoin.networks.Network,
): string | undefined {
  if (script.length === 34 && script[0] === 0x51 && script[1] === 0x20) {
    return bitcoin.address.toBech32(script.subarray(2), 1, network.bech32);
  }
  try {
    return bitcoin.address.fromOutputScript(script, network);
  } catch {
    return undefined;
  }
}
export function decodeRawTransaction(
  rawHex: string,
  network: NetworkName = "signet",
): BitcoinProtocolTx {
  const tx = bitcoin.Transaction.fromHex(rawHex.trim());
  const net = btcNetwork(network);
  return {
    txid: tx.getId(),
    version: tx.version,
    locktime: tx.locktime,
    inputs: tx.ins.map((input) => ({
      prevTxid: Buffer.from(input.hash).reverse().toString("hex"),
      vout: input.index,
      sequence: input.sequence,
    })),
    outputs: tx.outs.map((out, index) => {
      const spkHex = out.script.toString("hex");
      const decoded: DecodedOutput = {
        index,
        scriptPubKeyHex: spkHex,
        valueSats: BigInt(out.value),
      };
      if (
        out.script.length > 0 &&
        out.script[0] === bitcoin.opcodes.OP_RETURN
      ) {
        decoded.opReturnData = opReturnPayload(out.script);
      } else {
        decoded.address = outputAddress(out.script, net);
      }
      return decoded;
    }),
  };
}
export function opReturnPayload(script: Buffer): Uint8Array | undefined {
  if (script.length < 2 || script[0] !== 0x6a) return undefined;
  let offset = 1;
  let len = script[offset];
  if (len === undefined) return undefined;
  offset += 1;
  if (len === 0x4c) {
    if (script.length < offset + 1) return undefined;
    len = script[offset];
    offset += 1;
  } else if (len === 0x4d) {
    if (script.length < offset + 2) return undefined;
    len = script.readUInt16LE(offset);
    offset += 2;
  } else if (len === 0x4e) {
    if (script.length < offset + 4) return undefined;
    len = script.readUInt32LE(offset);
    offset += 4;
  }
  if (len === undefined) return undefined;
  if (offset + len > script.length) return undefined;
  return script.subarray(offset, offset + len);
}
export function parseCanonicalOpReturn(
  script: Uint8Array,
): Uint8Array | undefined {
  if (script.length < 2 || script[0] !== 0x6a) return undefined;
  const len = script[1]!;
  if (len >= 1 && len <= 75) {
    if (script.length !== 2 + len) return undefined;
    return script.subarray(2, 2 + len);
  }
  if (len === 0x4c && script.length >= 4) {
    const l = script[2]!;
    if (l < 76) return undefined;
    if (script.length !== 3 + l) return undefined;
    return script.subarray(3, 3 + l);
  }
  return undefined;
}
