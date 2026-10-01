import * as bitcoin from "bitcoinjs-lib";

export type CrcTradeOperation = "mint-buy" | "inventory-buy" | "sell";

export interface CrcPreflightExpectation {
  operation: CrcTradeOperation;
  deploymentTxid: string;
  ticker: string;
  vaultOutpoint: { txid: string; vout: number };
}

export interface CrcPreflightResult {
  operation: CrcTradeOperation;
  amountAtoms: bigint;
  recipientVout: 1;
  vaultVout: 1 | 2;
  recipientScript: Buffer;
  vaultScript: Buffer;
}

const LOT_ATOMS = 100_000_000_000n;
const MAX_ATOMS = 2_100_000_000_000_000n;

function markerPayload(psbt: bitcoin.Psbt): Record<string, unknown> {
  const first = psbt.txOutputs[0];
  if (!first || first.value !== 0 || first.script[0] !== bitcoin.opcodes.OP_RETURN)
    throw new Error("CRC marker must be zero-satoshi vout 0");
  const chunks = bitcoin.script.decompile(first.script);
  if (!chunks || chunks.length !== 2 || chunks[0] !== bitcoin.opcodes.OP_RETURN || !Buffer.isBuffer(chunks[1]))
    throw new Error("invalid CRC marker script");
  const bytes = chunks[1];
  if (bytes.length > 256 || bytes.length === 0 ||
    !first.script.equals(bitcoin.script.compile([bitcoin.opcodes.OP_RETURN!, bytes])))
    throw new Error("invalid CRC marker encoding");
  const raw = bytes.toString("utf8");
  if (!Buffer.from(raw, "utf8").equals(bytes)) throw new Error("invalid CRC marker UTF-8");
  let payload: unknown;
  try { payload = JSON.parse(raw); }
  catch { throw new Error("invalid CRC marker JSON"); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw new Error("invalid CRC marker object");
  if (JSON.stringify(payload) !== raw)
    throw new Error("duplicate field or noncanonical CRC marker JSON");
  return payload as Record<string, unknown>;
}

export function preflightCoveCrcPsbt(
  psbt: bitcoin.Psbt,
  expected: CrcPreflightExpectation,
): CrcPreflightResult {
  if (!/^[0-9a-f]{64}$/.test(expected.deploymentTxid) ||
    !/^[0-9a-f]{64}$/.test(expected.vaultOutpoint.txid) ||
    !Number.isSafeInteger(expected.vaultOutpoint.vout) || expected.vaultOutpoint.vout < 0)
    throw new Error("invalid trusted asset or vault reference");
  const payload = markerPayload(psbt);
  const keys = Object.keys(payload);
  const canonicalKeys = expected.operation === "mint-buy" ? ["p", "op", "tick"] : ["p", "op", "tick", "amt"];
  if (keys.length !== canonicalKeys.length || keys.some((key) => !canonicalKeys.includes(key)))
    throw new Error("CRC marker has unknown or missing field");
  if (keys.join(",") !== canonicalKeys.join(","))
    throw new Error("CRC marker field order mismatch");
  if (payload.p !== "crc-20") throw new Error("invalid CRC marker protocol");
  const requiredOp = expected.operation === "mint-buy" ? "mint" : "transfer";
  if (payload.op !== requiredOp) throw new Error("CRC operation mismatch");
  if (payload.tick !== expected.ticker) throw new Error("CRC ticker mismatch");
  if (expected.operation !== "mint-buy") {
    if (typeof payload.amt !== "string" || !/^[1-9][0-9]*$/.test(payload.amt))
    throw new Error("invalid CRC amount");
  }
  const amountAtoms = expected.operation === "mint-buy" ? 0n : BigInt(payload.amt as string);
  if (amountAtoms > MAX_ATOMS || amountAtoms % LOT_ATOMS !== 0n)
    throw new Error("invalid CRC amount lot or cap");

  const input0 = psbt.txInputs[0];
  if (!input0 || Buffer.from(input0.hash).reverse().toString("hex") !== expected.vaultOutpoint.txid ||
    input0.index !== expected.vaultOutpoint.vout)
    throw new Error("stale or wrong vault input");
  if (psbt.txInputs.length < 2) throw new Error("trade requires wallet funding or seller input");
  const seen = new Set<string>();
  for (let index = 0; index < psbt.txInputs.length; index++) {
    const input = psbt.txInputs[index]!;
    const outpoint = `${Buffer.from(input.hash).reverse().toString("hex")}:${input.index}`;
    if (seen.has(outpoint)) throw new Error("duplicate transaction input");
    seen.add(outpoint);
    const metadata = psbt.data.inputs[index];
    if (!metadata?.witnessUtxo) throw new Error("missing input prevout");
    if (metadata.sighashType !== bitcoin.Transaction.SIGHASH_ALL)
      throw new Error("all inputs must declare SIGHASH_ALL");
  }

  const outputs = psbt.txOutputs;
  const required = expected.operation === "sell" ? 4 : 5;
  const maxOutputs = required + (expected.operation === "sell" ? 2 : 1);
  if (outputs.length < required || outputs.length > maxOutputs)
    throw new Error("wrong number of CRC trade outputs");
  if (outputs.slice(1).some((out) => out.script[0] === bitcoin.opcodes.OP_RETURN))
    throw new Error("multiple CRC markers or unexpected OP_RETURN");
  const vaultVout = expected.operation === "sell" ? 1 : 2;
  for (const out of outputs.slice(1)) {
    if (out.value <= 0 || out.script.length === 0) throw new Error("invalid CRC payment output");
  }
  return {
    operation: expected.operation,
    amountAtoms,
    recipientVout: 1,
    vaultVout,
    recipientScript: outputs[1]!.script,
    vaultScript: outputs[vaultVout]!.script,
  };
}
