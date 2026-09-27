import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";
import { btcNetwork, type NetworkName } from "./decoder.js";
bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);
const ECPair = ECPairFactory(ecc);
export interface SignPsbtOutput {
  scriptPubKeyHex: string;
  valueSats: bigint;
}
export interface SignPsbtIntent {
  outputs: ReadonlyArray<SignPsbtOutput>;
  maxFeeSats: bigint;
  changeScriptPubKeyHex?: string;
}
export interface WalletSigner {
  getNetwork(): NetworkName;
  getAddress(): string;
  getPublicKeyHex(): string;
  signPsbt(psbtBase64: string, intent: SignPsbtIntent): Promise<string>;
}
export function decodeUnsignedOutputs(unsignedHex: string): SignPsbtOutput[] {
  const tx = bitcoin.Transaction.fromHex(unsignedHex.trim());
  return tx.outs.map((o) => ({
    scriptPubKeyHex: o.script.toString("hex"),
    valueSats: BigInt(o.value),
  }));
}
export { decodePsbtOutputs, scriptToAddress } from "./psbt-decode.js";
export type { PsbtDecodeOutput } from "./psbt-decode.js";
export function psbtIntent(
  unsignedHex: string,
  opts: {
    maxFeeSats: bigint;
    changeScriptPubKeyHex?: string;
  },
): SignPsbtIntent {
  const intent: SignPsbtIntent = {
    outputs: decodeUnsignedOutputs(unsignedHex),
    maxFeeSats: opts.maxFeeSats,
  };
  if (opts.changeScriptPubKeyHex)
    intent.changeScriptPubKeyHex = opts.changeScriptPubKeyHex;
  return intent;
}
export class LocalP2WPKHSigner implements WalletSigner {
  private readonly keyPair: ReturnType<typeof ECPair.fromWIF>;
  private readonly network: NetworkName;
  constructor(wif: string, network: NetworkName = "signet") {
    this.network = network;
    this.keyPair = ECPair.fromWIF(wif, btcNetwork(network));
  }
  static makeRandom(network: NetworkName = "signet"): LocalP2WPKHSigner {
    const kp = ECPair.makeRandom({ network: btcNetwork(network) });
    return new LocalP2WPKHSigner(kp.toWIF(), network);
  }
  toWIF(): string {
    return this.keyPair.toWIF();
  }
  getNetwork(): NetworkName {
    return this.network;
  }
  getAddress(): string {
    const net = btcNetwork(this.network);
    const p2wpkh = bitcoin.payments.p2wpkh({
      pubkey: this.keyPair.publicKey,
      network: net,
    });
    return p2wpkh.address!;
  }
  getPublicKeyHex(): string {
    return this.keyPair.publicKey.toString("hex");
  }
  async signPsbt(psbtBase64: string, intent: SignPsbtIntent): Promise<string> {
    const net = btcNetwork(this.network);
    const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network: net });
    const actual = psbt.txOutputs;
    if (actual.length !== intent.outputs.length) {
      throw new Error(
        `PSBT output count ${actual.length} != declared ${intent.outputs.length}`,
      );
    }
    for (let i = 0; i < intent.outputs.length; i++) {
      const exp = intent.outputs[i]!;
      const act = actual[i]!;
      const actScript = act.script.toString("hex");
      const actValue = BigInt(act.value);
      if (actScript !== exp.scriptPubKeyHex || actValue !== exp.valueSats) {
        throw new Error(
          `PSBT output[${i}] mismatch: declared ${exp.scriptPubKeyHex}:${exp.valueSats}, got ${actScript}:${actValue}`,
        );
      }
    }
    if (intent.changeScriptPubKeyHex !== undefined) {
      const last = actual[actual.length - 1];
      const lastScript = last?.script.toString("hex") ?? "(no change output)";
      if (lastScript !== intent.changeScriptPubKeyHex) {
        throw new Error(
          `PSBT change output script ${lastScript} != declared ${intent.changeScriptPubKeyHex}`,
        );
      }
    }
    let totalIn = 0n;
    for (let i = 0; i < psbt.data.inputs.length; i++) {
      const input = psbt.data.inputs[i]!;
      if (!input.witnessUtxo) {
        throw new Error(
          `PSBT input ${i} is missing witnessUtxo (cannot verify the fee)`,
        );
      }
      totalIn += BigInt(input.witnessUtxo.value);
    }
    const totalOut = actual.reduce((acc, o) => acc + BigInt(o.value), 0n);
    const fee = totalIn - totalOut;
    if (fee < 0n)
      throw new Error(
        `PSBT fee is negative (inputs ${totalIn} < outputs ${totalOut})`,
      );
    if (fee > intent.maxFeeSats) {
      throw new Error(
        `PSBT fee ${fee} exceeds declared max ${intent.maxFeeSats}`,
      );
    }
    const myScript = bitcoin.address.toOutputScript(this.getAddress(), net);
    for (let i = 0; i < psbt.data.inputs.length; i++) {
      const input = psbt.data.inputs[i]!;
      if (input.witnessUtxo && input.witnessUtxo.script.equals(myScript)) {
        psbt.signInput(i, this.keyPair, [bitcoin.Transaction.SIGHASH_ALL]);
        psbt.finalizeInput(i);
      }
    }
    return psbt.extractTransaction().toHex();
  }
}
