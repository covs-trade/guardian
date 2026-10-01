import * as bitcoin from "bitcoinjs-lib";
import { describe, expect, it } from "vitest";
import { preflightCoveCrcPsbt } from "./crc20-preflight.js";

const DEPLOY = "ab".repeat(32);
const VAULT_TX = "cd".repeat(32);
const buyer = Buffer.from(`0014${"11".repeat(20)}`, "hex");
const vault = Buffer.from(`5120${"22".repeat(32)}`, "hex");
const fee = Buffer.from(`0014${"33".repeat(20)}`, "hex");
const creator = Buffer.from(`0014${"44".repeat(20)}`, "hex");
const expected = { deploymentTxid: DEPLOY, ticker: "COVE", vaultOutpoint: { txid: VAULT_TX, vout: 1 } };

function fixture(operation: "mint-buy" | "inventory-buy" | "sell", payload?: object) {
  const psbt = new bitcoin.Psbt({ network: bitcoin.networks.regtest });
  psbt.addInput({ hash: VAULT_TX, index: 1, witnessUtxo: { script: vault, value: 10_000 },
    sighashType: bitcoin.Transaction.SIGHASH_ALL });
  psbt.addInput({ hash: "ef".repeat(32), index: 0, witnessUtxo: { script: buyer, value: 10_000 },
    sighashType: bitcoin.Transaction.SIGHASH_ALL });
  const marker = payload ?? (operation === "mint-buy"
    ? { p: "crc-20", op: "mint", tick: "COVE" }
    : { p: "crc-20", op: "transfer", tick: "COVE", amt: "100000000000" });
  psbt.addOutput({ script: bitcoin.script.compile([bitcoin.opcodes.OP_RETURN!,
    Buffer.from(JSON.stringify(marker))]), value: 0 });
  psbt.addOutput({ script: operation === "sell" ? vault : buyer, value: 330 });
  psbt.addOutput({ script: operation === "sell" ? buyer : vault, value: 1_000 });
  psbt.addOutput({ script: fee, value: 1_000 });
  if (operation !== "sell") psbt.addOutput({ script: creator, value: 546 });
  return psbt;
}

describe("single CRC Guardian wire preflight", () => {
  it("accepts amountless mint and four-field transfer with fixed recipient adjacency", () => {
    expect(preflightCoveCrcPsbt(fixture("mint-buy"), { ...expected, operation: "mint-buy" }))
      .toMatchObject({ amountAtoms: 0n, recipientVout: 1, vaultVout: 2 });
    expect(preflightCoveCrcPsbt(fixture("inventory-buy"), { ...expected, operation: "inventory-buy" }))
      .toMatchObject({ amountAtoms: 100_000_000_000n, recipientVout: 1, vaultVout: 2 });
    expect(preflightCoveCrcPsbt(fixture("sell"), { ...expected, operation: "sell" }))
      .toMatchObject({ amountAtoms: 100_000_000_000n, recipientVout: 1, vaultVout: 1 });
  });

  it("rejects the retired CRC fields and unsupported amounts", () => {
    for (const extra of [{ amt: "100000000000" }, { id: DEPLOY }, { v: 2 }, { ch: 4 }]) {
      expect(() => preflightCoveCrcPsbt(fixture("mint-buy", { p: "crc-20", op: "mint", tick: "COVE", ...extra }),
        { ...expected, operation: "mint-buy" })).toThrow(/field/i);
    }
    for (const extra of [{ id: DEPLOY }, { v: 2 }, { ch: 4 }]) {
      expect(() => preflightCoveCrcPsbt(fixture("sell", { p: "crc-20", op: "transfer", tick: "COVE",
        amt: "100000000000", ...extra }), { ...expected, operation: "sell" })).toThrow(/field/i);
    }
    expect(() => preflightCoveCrcPsbt(fixture("sell", { p: "crc-20", op: "transfer", tick: "COVE",
      amt: "0100000000000" }), { ...expected, operation: "sell" })).toThrow(/amount/i);
  });

  it("rejects wrong vault and non-SIGHASH_ALL", () => {
    const wrong = fixture("mint-buy");
    expect(() => preflightCoveCrcPsbt(wrong, { ...expected, operation: "mint-buy",
      vaultOutpoint: { txid: VAULT_TX, vout: 2 } })).toThrow(/vault/i);
    const sighash = fixture("mint-buy");
    sighash.data.inputs[1]!.sighashType = bitcoin.Transaction.SIGHASH_SINGLE;
    expect(() => preflightCoveCrcPsbt(sighash, { ...expected, operation: "mint-buy" })).toThrow(/SIGHASH_ALL/i);
  });
});
