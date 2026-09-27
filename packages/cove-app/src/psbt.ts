import { createHash } from "node:crypto";
import * as bitcoin from "bitcoinjs-lib";
import { checkSpendSignature, unfinalizeKeyInputs } from "@crclaunch/bitcoin";
import { AppError } from "./errors.js";
export function unsignedTxDigest(psbt: bitcoin.Psbt): string {
  return createHash("sha256")
    .update(psbt.data.globalMap.unsignedTx.toBuffer())
    .digest("hex");
}
export function parsePsbt(
  b64: string,
  network: bitcoin.networks.Network,
): bitcoin.Psbt {
  let psbt: bitcoin.Psbt;
  try {
    psbt = bitcoin.Psbt.fromBase64(b64, { network });
  } catch (e) {
    throw new AppError(
      "PSBT_MUTATED",
      `cannot parse PSBT: ${(e as Error).message}`,
    );
  }
  unfinalizeKeyInputs(psbt);
  return psbt;
}
export function btcNetwork(network: string): bitcoin.networks.Network {
  if (network === "regtest") return bitcoin.networks.regtest;
  if (network === "mainnet") return bitcoin.networks.bitcoin;
  return bitcoin.networks.testnet;
}
export function validateInputSignature(
  psbt: bitcoin.Psbt,
  inputIndex: number,
): void {
  const result = checkSpendSignature(psbt, inputIndex);
  if (!result.ok) throw new AppError("WALLET_SIGNATURE_INVALID", result.detail);
}
export function walletDeltaSats(
  psbt: bitcoin.Psbt,
  walletScriptsHex: string | string[],
): bigint {
  const mine = new Set(
    (Array.isArray(walletScriptsHex)
      ? walletScriptsHex
      : [walletScriptsHex]
    ).map((s) => s.toLowerCase()),
  );
  const into = psbt.txOutputs.reduce(
    (sum, out) =>
      mine.has(out.script.toString("hex")) ? sum + BigInt(out.value) : sum,
    0n,
  );
  const outOf = psbt.data.inputs.reduce(
    (sum, input) =>
      input.witnessUtxo && mine.has(input.witnessUtxo.script.toString("hex"))
        ? sum + BigInt(input.witnessUtxo.value)
        : sum,
    0n,
  );
  return into - outOf;
}
