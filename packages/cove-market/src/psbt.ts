import { createHash } from "node:crypto";
import * as bitcoin from "bitcoinjs-lib";
import { checkSpendSignature, unfinalizeKeyInputs } from "@crclaunch/bitcoin";
import { MarketError } from "./errors.js";
export function unsignedTxDigest(psbt: bitcoin.Psbt): string {
  const unsignedTx = psbt.data.globalMap.unsignedTx;
  const bytes = unsignedTx.toBuffer();
  return createHash("sha256").update(bytes).digest("hex");
}
export function sighashTypeOf(sig: Buffer): number {
  if (sig.length === 0)
    throw new MarketError("UNSAFE_SIGHASH", "empty signature");
  return sig[sig.length - 1]!;
}
export function isSighashAll(sig: Buffer): boolean {
  return sighashTypeOf(sig) === bitcoin.Transaction.SIGHASH_ALL;
}
export function partialSigOfInput(
  psbt: bitcoin.Psbt,
  inputIndex: number,
): Buffer | null {
  const input = psbt.data.inputs[inputIndex];
  if (!input) return null;
  if (input.tapKeySig && input.tapKeySig.length > 0)
    return Buffer.from(input.tapKeySig);
  if (!input.partialSig || input.partialSig.length === 0) return null;
  return Buffer.from(input.partialSig[0]!.signature);
}
export function inputMatchesPubkey(
  psbt: bitcoin.Psbt,
  inputIndex: number,
  pubkey: Buffer,
): boolean {
  const witnessUtxo = psbt.data.inputs[inputIndex]?.witnessUtxo;
  if (!witnessUtxo) return false;
  const expected = bitcoin.payments.p2wpkh({
    pubkey,
    network:
      (
        psbt as unknown as {
          network?: bitcoin.networks.Network;
        }
      ).network ?? bitcoin.networks.regtest,
  }).output;
  return !!expected && expected.equals(witnessUtxo.script);
}
export function validateP2wpkhPartialSig(
  psbt: bitcoin.Psbt,
  inputIndex: number,
): void {
  const result = checkSpendSignature(psbt, inputIndex);
  if (result.ok) return;
  if (result.reason === "NOT_SIGHASH_ALL")
    throw new MarketError("UNSAFE_SIGHASH", result.detail);
  throw new MarketError("BUYER_SIGNATURE_INVALID", result.detail);
}
export function parsePsbt(
  b64: string,
  network: bitcoin.networks.Network,
): bitcoin.Psbt {
  let psbt: bitcoin.Psbt;
  try {
    psbt = bitcoin.Psbt.fromBase64(b64, { network });
  } catch (e) {
    throw new MarketError(
      "PSBT_MUTATED",
      `cannot parse PSBT: ${(e as Error).message}`,
    );
  }
  unfinalizeKeyInputs(psbt);
  return psbt;
}
