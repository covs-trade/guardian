import * as bitcoin from "bitcoinjs-lib";
import { decodeV2, type ParsedEnvelopeV2 } from "@crclaunch/cove-wire";
import type { OutPoint } from "@crclaunch/cove-covenant";
export interface PsbtInputView {
  index: number;
  outpoint: OutPoint;
  script: Buffer;
  valueSats: bigint;
}
export interface PsbtOutputView {
  vout: number;
  script: Buffer;
  value: bigint;
}
export function readPsbtInputs(psbt: bitcoin.Psbt): PsbtInputView[] {
  const out: PsbtInputView[] = [];
  const txInputs = psbt.txInputs;
  for (let i = 0; i < psbt.data.inputs.length; i++) {
    const txid = Buffer.from(txInputs[i]!.hash).reverse().toString("hex");
    const wu = psbt.data.inputs[i]!.witnessUtxo;
    out.push({
      index: i,
      outpoint: { txid, vout: txInputs[i]!.index },
      script: wu ? Buffer.from(wu.script) : Buffer.alloc(0),
      valueSats: wu ? BigInt(wu.value) : 0n,
    });
  }
  return out;
}
export function readPsbtOutputs(psbt: bitcoin.Psbt): PsbtOutputView[] {
  return psbt.txOutputs.map((o, vout) => ({
    vout,
    script: Buffer.from(o.script),
    value: BigInt(o.value),
  }));
}
export function decodeCoveOpReturn(psbt: bitcoin.Psbt): ParsedEnvelopeV2 {
  const out0 = psbt.txOutputs[0];
  if (!out0) throw new Error("NO_OUTPUT_0");
  const script = Buffer.from(out0.script);
  if (script.length < 2 || script[0] !== 0x6a)
    throw new Error("NO_COVE_OP_RETURN");
  const len = script[1]!;
  if (script.length !== 2 + len) throw new Error("NONCANONICAL_WIRE");
  return decodeV2(Buffer.from(script.subarray(2)));
}
export function decodeCoveOpReturnTx(
  tx: bitcoin.Transaction,
): ParsedEnvelopeV2 {
  const script = tx.outs[0]?.script;
  if (!script || script.length < 2 || script[0] !== 0x6a)
    throw new Error("NO_COVE_OP_RETURN");
  const len = script[1]!;
  if (script.length !== 2 + len) throw new Error("NONCANONICAL_WIRE");
  return decodeV2(Buffer.from(script.subarray(2)));
}
export function unsignedTransaction(psbt: bitcoin.Psbt): bitcoin.Transaction {
  const tx = new bitcoin.Transaction();
  tx.version = 2;
  for (const i of psbt.txInputs) {
    tx.ins.push({
      hash: Buffer.from(i.hash),
      index: i.index,
      script: Buffer.alloc(0),
      sequence: i.sequence ?? 0xffffffff,
      witness: [],
    });
  }
  for (const o of psbt.txOutputs) {
    tx.outs.push({ script: Buffer.from(o.script), value: o.value });
  }
  return tx;
}
export function unsignedTxDigest(psbt: bitcoin.Psbt): string {
  return unsignedTransaction(psbt).getId();
}
