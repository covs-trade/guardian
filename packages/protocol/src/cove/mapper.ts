import type { BitcoinProtocolTx } from "@crclaunch/bitcoin";
import type { CoveEnvelope } from "./envelope.js";
import type { CoveTransaction, ProtocolOwnerId } from "./types.js";
export type CoveMapResult =
  | {
      ok: true;
      tx: CoveTransaction;
    }
  | {
      ok: false;
      reason: string;
    };
export function toCoveTransaction(
  btcTx: BitcoinProtocolTx,
  envelope: CoveEnvelope,
  txIndex: number,
): CoveMapResult {
  const input0 = btcTx.inputs[0];
  if (!input0?.prevScriptPubKeyHex)
    return { ok: false, reason: "MISSING_INPUT0_PREVOUT" };
  const actor: ProtocolOwnerId = input0.prevScriptPubKeyHex;
  if (envelope.op === "deploy") {
    const feeOut = btcTx.outputs[1];
    return {
      ok: true,
      tx: {
        operation: "DEPLOY",
        txid: btcTx.txid,
        txIndex,
        actor,
        ticker: envelope.tick,
        protocolOutputs: feeOut
          ? [
              {
                index: 1,
                scriptPubKeyHex: feeOut.scriptPubKeyHex,
                amountSats: feeOut.valueSats,
                role: "launch-fee",
              },
            ]
          : [],
      },
    };
  }
  if (envelope.op === "mint") {
    const recipient = btcTx.outputs[1];
    const settlement = btcTx.outputs[2];
    return {
      ok: true,
      tx: {
        operation: "MINT",
        txid: btcTx.txid,
        txIndex,
        actor,
        recipient: recipient?.scriptPubKeyHex,
        ticker: envelope.tick,
        amountAtoms: envelope.amt,
        supplyBeforeAtoms: envelope.s,
        protocolOutputs: [
          recipient
            ? {
                index: 1,
                scriptPubKeyHex: recipient.scriptPubKeyHex,
                amountSats: recipient.valueSats,
                role: "recipient",
              }
            : undefined,
          settlement
            ? {
                index: 2,
                scriptPubKeyHex: settlement.scriptPubKeyHex,
                amountSats: settlement.valueSats,
                role: "settlement",
              }
            : undefined,
        ].filter((o): o is NonNullable<typeof o> => o !== undefined),
      },
    };
  }
  const recipient = btcTx.outputs[1];
  const continuation = btcTx.outputs[2];
  return {
    ok: true,
    tx: {
      operation: "TRANSFER",
      txid: btcTx.txid,
      txIndex,
      actor,
      recipient: recipient?.scriptPubKeyHex,
      ticker: envelope.tick,
      amountAtoms: envelope.amt,
      protocolOutputs: [
        recipient
          ? {
              index: 1,
              scriptPubKeyHex: recipient.scriptPubKeyHex,
              amountSats: recipient.valueSats,
              role: "recipient",
            }
          : undefined,
        continuation
          ? {
              index: 2,
              scriptPubKeyHex: continuation.scriptPubKeyHex,
              amountSats: continuation.valueSats,
              role: "continuation",
            }
          : undefined,
      ].filter((o): o is NonNullable<typeof o> => o !== undefined),
    },
  };
}
