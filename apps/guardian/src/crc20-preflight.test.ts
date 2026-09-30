import * as bitcoin from "bitcoinjs-lib";
import { describe, expect, it } from "vitest";
import { preflightCoveCrcPsbt } from "./crc20-preflight.js";

const ID = "ab".repeat(32);
const VAULT_TXID = "cd".repeat(32);
const BUYER = Buffer.from(`0014${"11".repeat(20)}`, "hex");
const VAULT = Buffer.from(`5120${"22".repeat(32)}`, "hex");
const FEE = Buffer.from(`0014${"33".repeat(20)}`, "hex");
const CREATOR = Buffer.from(`0014${"44".repeat(20)}`, "hex");

function fixture(options: {
  op?: "mint" | "transfer";
  id?: string;
  amt?: string;
  tick?: string;
  extra?: Record<string, string>;
  markerVout?: number;
  secondMarker?: boolean;
  sighash?: number;
  firstTxid?: string;
  outputCount?: number;
} = {}) {
  const marker = bitcoin.script.compile([
    bitcoin.opcodes.OP_RETURN!,
    Buffer.from(JSON.stringify({
      p: "crc-20",
      op: options.op ?? "mint",
      tick: options.tick ?? "COVE",
      amt: options.amt ?? "100000000000",
      id: options.id ?? ID,
      ...options.extra,
    })),
  ]);
  const outputs = [
    { script: marker, value: 0 },
    { script: BUYER, value: 330 },
    { script: VAULT, value: 100_000 },
    { script: FEE, value: 5_000 },
    { script: CREATOR, value: 546 },
  ];
  if (options.markerVout === 1) [outputs[0], outputs[1]] = [outputs[1]!, outputs[0]!];
  if (options.secondMarker) outputs.push({ script: marker, value: 0 });
  const psbt = new bitcoin.Psbt({ network: bitcoin.networks.regtest });
  psbt.addInput({
    hash: options.firstTxid ?? VAULT_TXID,
    index: 2,
    witnessUtxo: { script: VAULT, value: 100_000 },
    sighashType: options.sighash ?? bitcoin.Transaction.SIGHASH_ALL,
  });
  psbt.addInput({
    hash: "ef".repeat(32),
    index: 1,
    witnessUtxo: { script: BUYER, value: 6_000 },
    sighashType: bitcoin.Transaction.SIGHASH_ALL,
  });
  for (const output of outputs.slice(0, options.outputCount)) psbt.addOutput(output);
  return psbt;
}

const expected = {
  operation: "mint-buy" as const,
  deploymentTxid: ID,
  ticker: "COVE",
  vaultOutpoint: { txid: VAULT_TXID, vout: 2 },
};

describe("Cove CRC-20 Guardian PSBT preflight", () => {
  it("accepts a canonical mint-buy and returns the committed amount", () => {
    expect(preflightCoveCrcPsbt(fixture(), expected)).toMatchObject({
      operation: "mint-buy",
      amountAtoms: 100000000000n,
      recipientVout: 1,
      vaultVout: 2,
    });
  });

  it("requires an exact registered asset ID and ticker", () => {
    expect(() => preflightCoveCrcPsbt(fixture({ id: "de".repeat(32) }), expected)).toThrow(/asset/i);
    expect(() => preflightCoveCrcPsbt(fixture({ tick: "LEAF" }), expected)).toThrow(/ticker/i);
  });

  it("rejects stale vaults and a marker outside vout zero", () => {
    expect(() => preflightCoveCrcPsbt(fixture({ firstTxid: "01".repeat(32) }), expected)).toThrow(/vault/i);
    expect(() => preflightCoveCrcPsbt(fixture({ markerVout: 1 }), expected)).toThrow(/marker/i);
  });

  it("rejects unknown fields, duplicate JSON keys, and noncanonical amounts", () => {
    expect(() => preflightCoveCrcPsbt(fixture({ extra: { x: "1" } }), expected)).toThrow(/field/i);
    expect(() => preflightCoveCrcPsbt(fixture({ amt: "0100" }), expected)).toThrow(/amount/i);
    const psbt = fixture();
    const duplicate = bitcoin.script.compile([
      bitcoin.opcodes.OP_RETURN!,
      Buffer.from(`{"p":"crc-20","op":"mint","tick":"COVE","amt":"100000000000","id":"${ID}","amt":"200000000000"}`),
    ]);
    const tx = psbt.txOutputs.map((out, index) => ({ script: index === 0 ? duplicate : out.script, value: out.value }));
    const altered = new bitcoin.Psbt({ network: bitcoin.networks.regtest });
    for (const input of psbt.txInputs.map((input, index) => ({
      hash: Buffer.from(input.hash).reverse().toString("hex"),
      index: input.index,
      witnessUtxo: psbt.data.inputs[index]!.witnessUtxo!,
      sighashType: bitcoin.Transaction.SIGHASH_ALL,
    }))) altered.addInput(input);
    for (const out of tx) altered.addOutput(out);
    expect(() => preflightCoveCrcPsbt(altered, expected)).toThrow(/duplicate/i);
  });

  it("rejects another marker, missing fee outputs, and non-ALL hash modes", () => {
    expect(() => preflightCoveCrcPsbt(fixture({ secondMarker: true }), expected)).toThrow(/marker/i);
    expect(() => preflightCoveCrcPsbt(fixture({ outputCount: 3 }), expected)).toThrow(/outputs/i);
    expect(() => preflightCoveCrcPsbt(fixture({ sighash: bitcoin.Transaction.SIGHASH_SINGLE }), expected)).toThrow(/sighash/i);
  });

  it("distinguishes inventory buys and sells by expected operation and output layout", () => {
    expect(() => preflightCoveCrcPsbt(fixture({ op: "transfer" }), expected)).toThrow(/operation/i);
    expect(preflightCoveCrcPsbt(fixture({ op: "transfer" }), { ...expected, operation: "inventory-buy" })).toMatchObject({
      operation: "inventory-buy", recipientVout: 1, vaultVout: 2,
    });
    expect(preflightCoveCrcPsbt(fixture({ op: "transfer", outputCount: 4 }), { ...expected, operation: "sell" })).toMatchObject({
      operation: "sell", recipientVout: 1, vaultVout: 1,
    });
  });
});
