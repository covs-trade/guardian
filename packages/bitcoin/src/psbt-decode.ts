import * as bitcoin from "bitcoinjs-lib";
import { btcNetwork, type NetworkName } from "./decoder.js";
export type { NetworkName } from "./decoder.js";
export interface PsbtDecodeOutput {
  scriptPubKeyHex: string;
  valueSats: bigint;
}
export function decodePsbtOutputs(
  psbtBase64: string,
  network: NetworkName = "signet",
): PsbtDecodeOutput[] {
  const psbt = bitcoin.Psbt.fromBase64(psbtBase64, {
    network: btcNetwork(network),
  });
  return psbt.txOutputs.map((o) => ({
    scriptPubKeyHex: o.script.toString("hex"),
    valueSats: BigInt(o.value),
  }));
}
export function scriptToAddress(
  scriptPubKeyHex: string,
  network: NetworkName = "signet",
): string | undefined {
  try {
    return bitcoin.address.fromOutputScript(
      Buffer.from(scriptPubKeyHex, "hex"),
      btcNetwork(network),
    );
  } catch {
    return undefined;
  }
}
