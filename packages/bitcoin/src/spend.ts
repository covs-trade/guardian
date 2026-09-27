import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { isP2TR, isP2WPKH } from "./dust.js";
bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);
export type SpendKind = "p2wpkh" | "p2sh-p2wpkh" | "p2tr";
export function isP2SH(script: Uint8Array): boolean {
  return (
    script.length === 23 &&
    script[0] === 0xa9 &&
    script[1] === 0x14 &&
    script[22] === 0x87
  );
}
export function spendKindOf(script: Uint8Array): SpendKind | null {
  if (isP2WPKH(script)) return "p2wpkh";
  if (isP2TR(script)) return "p2tr";
  if (isP2SH(script)) return "p2sh-p2wpkh";
  return null;
}
export function xOnly(publicKey: Uint8Array): Buffer {
  const key = Buffer.from(publicKey);
  return key.length === 32 ? key : key.subarray(1, 33);
}
export function scriptForKind(
  kind: SpendKind,
  publicKey: Uint8Array,
  network: bitcoin.networks.Network,
): Buffer {
  const pubkey = Buffer.from(publicKey);
  switch (kind) {
    case "p2wpkh":
      return bitcoin.payments.p2wpkh({ pubkey, network }).output!;
    case "p2sh-p2wpkh":
      return bitcoin.payments.p2sh({
        redeem: bitcoin.payments.p2wpkh({ pubkey, network }),
        network,
      }).output!;
    case "p2tr":
      return bitcoin.payments.p2tr({ internalPubkey: xOnly(pubkey), network })
        .output!;
  }
}
export interface SpendableInput {
  txid: string;
  vout: number;
  script: Buffer;
  valueSats: bigint;
  publicKey?: Buffer;
}
export function psbtInputFor(
  input: SpendableInput,
  network: bitcoin.networks.Network,
): Parameters<bitcoin.Psbt["addInput"]>[0] {
  const kind = spendKindOf(input.script);
  if (kind === null) {
    throw new Error(
      `cannot spend ${input.txid}:${input.vout}: unsupported address type ` +
        `(script ${input.script.toString("hex").slice(0, 16)}…)`,
    );
  }
  const base = {
    hash: input.txid,
    index: input.vout,
    witnessUtxo: { script: input.script, value: Number(input.valueSats) },
  };
  if (kind === "p2wpkh") return base;
  if (!input.publicKey) {
    throw new Error(
      `cannot spend ${input.txid}:${input.vout}: a ${kind} input needs the owner's public key`,
    );
  }
  const derived = scriptForKind(kind, input.publicKey, network);
  if (!derived.equals(input.script)) {
    throw new Error(
      `cannot spend ${input.txid}:${input.vout}: the supplied public key does not control it`,
    );
  }
  if (kind === "p2sh-p2wpkh") {
    return {
      ...base,
      redeemScript: bitcoin.payments.p2wpkh({
        pubkey: Buffer.from(input.publicKey),
        network,
      }).output!,
    };
  }
  return { ...base, tapInternalKey: xOnly(input.publicKey) };
}
export const WITNESS_VBYTES: Record<SpendKind, number> = {
  p2wpkh: 27,
  "p2sh-p2wpkh": 50,
  p2tr: 17,
};
export function inputVbytes(kind: SpendKind): number {
  return 41 + WITNESS_VBYTES[kind];
}
export type SignatureProblem =
  | {
      ok: true;
    }
  | {
      ok: false;
      reason: "UNSIGNED" | "NOT_SIGHASH_ALL" | "INVALID" | "UNSUPPORTED";
      detail: string;
    };
export function checkSpendSignature(
  psbt: bitcoin.Psbt,
  index: number,
): SignatureProblem {
  return checkSignatureWithSighash(
    psbt,
    index,
    bitcoin.Transaction.SIGHASH_ALL,
  );
}
export const SIGHASH_SINGLE_ANYONECANPAY =
  bitcoin.Transaction.SIGHASH_SINGLE | bitcoin.Transaction.SIGHASH_ANYONECANPAY;
export function checkListingSignature(
  psbt: bitcoin.Psbt,
  index: number,
): SignatureProblem {
  return checkSignatureWithSighash(psbt, index, SIGHASH_SINGLE_ANYONECANPAY);
}
function checkSignatureWithSighash(
  psbt: bitcoin.Psbt,
  index: number,
  sighash: number,
): SignatureProblem {
  const input = psbt.data.inputs[index];
  if (!input)
    return {
      ok: false,
      reason: "UNSIGNED",
      detail: `input ${index} does not exist`,
    };
  const all = sighash === bitcoin.Transaction.SIGHASH_ALL;
  const wanted = all ? "SIGHASH_ALL" : `sighash 0x${sighash.toString(16)}`;
  const script = input.witnessUtxo?.script;
  const kind = script ? spendKindOf(script) : null;
  if (kind === null) {
    return {
      ok: false,
      reason: "UNSUPPORTED",
      detail: `input ${index} has an unsupported script`,
    };
  }
  if (kind === "p2tr") {
    const sig = input.tapKeySig;
    if (!sig || sig.length === 0) {
      return {
        ok: false,
        reason: "UNSIGNED",
        detail: `input ${index} unsigned`,
      };
    }
    if (sig.length !== 64 && sig.length !== 65) {
      return {
        ok: false,
        reason: "INVALID",
        detail: `input ${index} taproot signature is malformed`,
      };
    }
    const hashType =
      sig.length === 65 ? sig[64]! : bitcoin.Transaction.SIGHASH_DEFAULT;
    const matches = all
      ? hashType === bitcoin.Transaction.SIGHASH_DEFAULT || hashType === sighash
      : sig.length === 65 && hashType === sighash;
    if (!matches) {
      return {
        ok: false,
        reason: "NOT_SIGHASH_ALL",
        detail: `input ${index} taproot sighash 0x${hashType.toString(16)} is not ${wanted}`,
      };
    }
    let ok = false;
    try {
      const tx = bitcoin.Transaction.fromBuffer(
        psbt.data.globalMap.unsignedTx.toBuffer(),
      );
      const prevScripts = psbt.data.inputs.map((i) =>
        Buffer.from(i.witnessUtxo!.script),
      );
      const values = psbt.data.inputs.map((i) => i.witnessUtxo!.value);
      const digest = tx.hashForWitnessV1(index, prevScripts, values, hashType);
      ok = ecc.verifySchnorr(
        digest,
        Buffer.from(script!.subarray(2, 34)),
        Buffer.from(sig.subarray(0, 64)),
      );
    } catch {
      ok = false;
    }
    return ok
      ? { ok: true }
      : {
          ok: false,
          reason: "INVALID",
          detail: `input ${index} signature invalid`,
        };
  }
  if (!input.partialSig || input.partialSig.length === 0) {
    return { ok: false, reason: "UNSIGNED", detail: `input ${index} unsigned` };
  }
  const sig = Buffer.from(input.partialSig[0]!.signature);
  if (sig.length === 0 || sig[sig.length - 1] !== sighash) {
    return {
      ok: false,
      reason: "NOT_SIGHASH_ALL",
      detail: `input ${index} is not ${wanted}`,
    };
  }
  if (kind === "p2sh-p2wpkh" && !input.redeemScript) {
    return {
      ok: false,
      reason: "INVALID",
      detail: `input ${index} is nested segwit but carries no redeemScript`,
    };
  }
  let ok = false;
  try {
    ok = psbt.validateSignaturesOfInput(index, (pubkey, msghash, signature) =>
      ecc.verify(msghash, pubkey, signature),
    );
  } catch {
    ok = false;
  }
  return ok
    ? { ok: true }
    : {
        ok: false,
        reason: "INVALID",
        detail: `input ${index} signature invalid`,
      };
}
export function unfinalizeKeyInputs(psbt: bitcoin.Psbt): void {
  psbt.data.inputs.forEach((input) => {
    if (
      !input.finalScriptWitness ||
      input.partialSig?.length ||
      input.tapKeySig
    )
      return;
    const script = input.witnessUtxo?.script;
    if (!script) return;
    const kind = spendKindOf(script);
    const stack = witnessStack(Buffer.from(input.finalScriptWitness));
    const restored: Record<string, unknown> = {};
    if ((kind === "p2wpkh" || kind === "p2sh-p2wpkh") && stack.length === 2) {
      const pubkey = stack[1]!;
      restored.partialSig = [{ pubkey, signature: stack[0]! }];
      if (kind === "p2sh-p2wpkh")
        restored.redeemScript = bitcoin.payments.p2wpkh({ pubkey }).output!;
    } else if (
      kind === "p2tr" &&
      stack.length === 1 &&
      (stack[0]!.length === 64 || stack[0]!.length === 65)
    ) {
      restored.tapKeySig = stack[0]!;
    } else {
      return;
    }
    delete (
      input as {
        finalScriptWitness?: Buffer;
      }
    ).finalScriptWitness;
    delete (
      input as {
        finalScriptSig?: Buffer;
      }
    ).finalScriptSig;
    Object.assign(input, restored);
  });
}
function witnessStack(buf: Buffer): Buffer[] {
  let o = 0;
  const varint = (): number => {
    const b = buf[o++]!;
    if (b < 0xfd) return b;
    if (b === 0xfd) {
      const v = buf.readUInt16LE(o);
      o += 2;
      return v;
    }
    const v = buf.readUInt32LE(o);
    o += 4;
    return v;
  };
  const n = varint();
  const out: Buffer[] = [];
  for (let k = 0; k < n; k++) {
    const len = varint();
    out.push(buf.subarray(o, o + len));
    o += len;
  }
  return out;
}
