import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import type { ChainUtxo } from "./provider.js";
import { btcNetwork, opReturnPayload, type NetworkName } from "./decoder.js";
import { dustThreshold, isP2TR, isP2WPKH } from "./dust.js";
bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);
export type TxOutput =
  | {
      readonly script: Uint8Array;
      readonly valueSats: bigint;
      readonly address?: never;
    }
  | {
      readonly address: string;
      readonly valueSats: bigint;
      readonly script?: never;
    };
export interface CovePsbt {
  psbtBase64: string;
  unsignedHex: string;
  opReturnHex: string;
  feeSats: bigint;
  changeSats: bigint;
}
export function opReturnScript(json: string): Buffer {
  return bitcoin.script.compile([0x6a, Buffer.from(json, "utf8")]);
}
export function opReturnScriptData(data: Uint8Array): Buffer {
  return bitcoin.script.compile([0x6a, Buffer.from(data)]);
}
export interface BuildTxParams {
  network: NetworkName;
  inputs: ChainUtxo[];
  outputs: TxOutput[];
  changeAddress: string;
  feeRateSatVb: bigint;
  maxFeeRateSatVb: bigint;
  maxMinerFeeSats: bigint;
}
const MAX_MONEY_SATS = 2100000000000000n;
const MAX_OP_RETURN_PAYLOAD = 80;
export function estimateInputVsize(scriptPubKeyHex: string): number {
  const script = Buffer.from(scriptPubKeyHex, "hex");
  if (isP2TR(script)) return 58;
  if (isP2WPKH(script)) return 68;
  return 148;
}
export function estimateOutputVsize(script: Uint8Array): number {
  return 8 + 1 + script.length;
}
function resolveOutputScript(
  out: TxOutput,
  net: bitcoin.networks.Network,
): Buffer {
  if (out.script) return Buffer.from(out.script);
  if (out.address) return bitcoin.address.toOutputScript(out.address, net);
  throw new Error("Output has neither address nor script.");
}
export function buildUnsignedPsbt(params: BuildTxParams): CovePsbt {
  const net = btcNetwork(params.network);
  if (params.inputs.length === 0) throw new Error("No inputs provided.");
  if (params.feeRateSatVb <= 0n)
    throw new Error("Fee rate must be > 0 sat/vB.");
  if (params.feeRateSatVb > params.maxFeeRateSatVb) {
    throw new Error(
      `fee rate ${params.feeRateSatVb} exceeds max ${params.maxFeeRateSatVb}`,
    );
  }
  const psbt = new bitcoin.Psbt({ network: net });
  const seenOutpoints = new Set<string>();
  let totalIn = 0n;
  let hasWitness = false;
  let vsize = 10;
  for (let i = 0; i < params.inputs.length; i++) {
    const u = params.inputs[i]!;
    if (u.valueSats < 0n || u.valueSats > MAX_MONEY_SATS)
      throw new Error("Input value out of range.");
    const outpoint = `${u.txid}:${u.vout}`;
    if (seenOutpoints.has(outpoint))
      throw new Error("Duplicate input detected.");
    seenOutpoints.add(outpoint);
    totalIn += u.valueSats;
    const script = Buffer.from(u.scriptPubKeyHex, "hex");
    const value = Number(u.valueSats);
    if (isP2WPKH(script)) {
      hasWitness = true;
      vsize += estimateInputVsize(u.scriptPubKeyHex);
      psbt.addInput({
        hash: u.txid,
        index: u.vout,
        sequence: 0xfffffffd,
        witnessUtxo: { script, value },
        sighashType: bitcoin.Transaction.SIGHASH_ALL,
      });
    } else if (isP2TR(script)) {
      hasWitness = true;
      vsize += estimateInputVsize(u.scriptPubKeyHex);
      if (!u.tapInternalKeyHex) {
        throw new Error(
          `Input ${i} is P2TR but no tapInternalKeyHex was supplied. ` +
            "The untweaked internal key P cannot be derived from the scriptPubKey.",
        );
      }
      const tapInternalKey = Buffer.from(u.tapInternalKeyHex, "hex");
      if (tapInternalKey.length !== 32) {
        throw new Error(
          `Input ${i} tapInternalKeyHex must be 32 bytes, got ${tapInternalKey.length}.`,
        );
      }
      psbt.addInput({
        hash: u.txid,
        index: u.vout,
        sequence: 0xfffffffd,
        witnessUtxo: { script, value },
        tapInternalKey,
      });
    } else {
      throw new Error(
        `Input ${i} has an unsupported script type (only P2WPKH/P2TR are signable).`,
      );
    }
  }
  if (hasWitness) vsize += 2;
  let opReturnCount = 0;
  let totalProtocolOut = 0n;
  let trackedOutTotal = 0n;
  for (let i = 0; i < params.outputs.length; i++) {
    const o = params.outputs[i]!;
    if (o.valueSats < 0n || o.valueSats > MAX_MONEY_SATS)
      throw new Error("Output value out of range.");
    const script = resolveOutputScript(o, net);
    if (script[0] === 0x6a) {
      opReturnCount += 1;
      const payload = opReturnPayload(script);
      if (payload && payload.length > MAX_OP_RETURN_PAYLOAD) {
        throw new Error(
          `OP_RETURN payload ${payload.length} exceeds ${MAX_OP_RETURN_PAYLOAD} bytes.`,
        );
      }
    }
    totalProtocolOut += o.valueSats;
    trackedOutTotal += o.valueSats;
    vsize += estimateOutputVsize(script);
    if (o.address !== undefined) {
      psbt.addOutput({ address: o.address, value: Number(o.valueSats) });
    } else {
      psbt.addOutput({ script, value: Number(o.valueSats) });
    }
  }
  if (opReturnCount > 1)
    throw new Error("More than one OP_RETURN output (non-relayable).");
  const changeScript = bitcoin.address.toOutputScript(
    params.changeAddress,
    net,
  );
  vsize += estimateOutputVsize(changeScript);
  const estFee = BigInt(vsize) * params.feeRateSatVb;
  let changeSats = totalIn - totalProtocolOut - estFee;
  if (changeSats < 0n)
    throw new Error("Insufficient inputs for fee + outputs.");
  const changeDust = dustThreshold(changeScript);
  if (changeSats >= changeDust) {
    psbt.addOutput({
      address: params.changeAddress,
      value: Number(changeSats),
    });
    trackedOutTotal += changeSats;
  } else {
    changeSats = 0n;
  }
  const cached = (
    psbt as unknown as {
      __CACHE: {
        __TX: bitcoin.Transaction;
      };
    }
  ).__CACHE;
  const txOutTotal = cached.__TX.outs.reduce(
    (acc, out) => acc + BigInt(out.value),
    0n,
  );
  if (trackedOutTotal !== txOutTotal)
    throw new Error("output accounting mismatch");
  const actualFee = totalIn - txOutTotal;
  if (actualFee < 0n) throw new Error("negative fee");
  if (actualFee > params.maxMinerFeeSats) {
    throw new Error(`fee ${actualFee} exceeds max ${params.maxMinerFeeSats}`);
  }
  const unsignedHex = cached.__TX.toHex();
  const opReturnOut = params.outputs.find(
    (o) => o.script && o.script[0] === 0x6a,
  );
  const opReturnHex = opReturnOut?.script
    ? Buffer.from(opReturnOut.script).toString("hex")
    : "";
  return {
    psbtBase64: psbt.toBase64(),
    unsignedHex,
    opReturnHex,
    feeSats: actualFee,
    changeSats,
  };
}
