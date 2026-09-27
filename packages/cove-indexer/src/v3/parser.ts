import * as bitcoin from "bitcoinjs-lib";
import {
  COVE_WIRE_MAGIC,
  OP_DEPLOY,
  OP_MINT,
  OP_REDEEM,
  OP_TRANSFER,
  decodeV2,
  type ParsedEnvelopeV2,
} from "@crclaunch/cove-wire";
export type ParsedCoveTx =
  | {
      kind: "NON_COVE";
    }
  | {
      kind: "INVALID";
      reason: string;
    }
  | {
      kind: "DEPLOY";
      envelope: ParsedEnvelopeV2;
    }
  | {
      kind: "MINT";
      envelope: ParsedEnvelopeV2;
    }
  | {
      kind: "TRANSFER";
      envelope: ParsedEnvelopeV2;
    }
  | {
      kind: "REDEEM";
      envelope: ParsedEnvelopeV2;
    };
export function parseCoveTx(rawHex: string): ParsedCoveTx {
  let tx: bitcoin.Transaction;
  try {
    tx = bitcoin.Transaction.fromHex(rawHex);
  } catch {
    return { kind: "INVALID", reason: "BAD_TX" };
  }
  const out0 = tx.outs[0];
  if (!out0) return { kind: "NON_COVE" };
  const script = out0.script;
  if (script.length < 2 || script[0] !== 0x6a) return { kind: "NON_COVE" };
  const len = script[1]!;
  if (script.length !== 2 + len)
    return { kind: "INVALID", reason: "BAD_OP_RETURN_LENGTH" };
  const payload = script.subarray(2);
  if (payload.length < 4 || payload.readUInt16BE(0) !== COVE_WIRE_MAGIC) {
    return { kind: "NON_COVE" };
  }
  try {
    const envelope = decodeV2(payload);
    switch (envelope.op) {
      case OP_DEPLOY:
        return { kind: "DEPLOY", envelope };
      case OP_MINT:
        return { kind: "MINT", envelope };
      case OP_TRANSFER:
        return { kind: "TRANSFER", envelope };
      case OP_REDEEM:
        return { kind: "REDEEM", envelope };
      default:
        return { kind: "INVALID", reason: "BAD_OPCODE" };
    }
  } catch (e) {
    const code = (
      e as {
        code?: string;
      }
    ).code;
    return { kind: "INVALID", reason: code ?? "MALFORMED_WIRE" };
  }
}
export function txidOf(rawHex: string): string {
  return bitcoin.Transaction.fromHex(rawHex).getId();
}
