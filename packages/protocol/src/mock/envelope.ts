import { randomBytes } from "node:crypto";
import type { Sats } from "@crclaunch/curve";
import type {
  ProtocolOperation,
  TransactionInput,
  TransactionOutput,
} from "../types.js";
import type { MockTxEnvelope, MockTxPayload } from "./types.js";
import { bigintReplacer, bigintReviver } from "./serialize.js";
const SIGNATURE_MARKER = "MOCK-SIGNED-BY:";
export function newMockTxid(): string {
  return randomBytes(16).toString("hex");
}
export interface BuildEnvelopeInput {
  op: ProtocolOperation;
  network: string;
  payload: MockTxPayload;
  inputs: TransactionInput[];
  outputs: TransactionOutput[];
  feeSats: Sats;
  stateHash: string;
  expiresAtHeight: bigint;
  expiresAtTimestamp: string;
}
export function buildEnvelope(input: BuildEnvelopeInput): MockTxEnvelope {
  return {
    v: 1,
    op: input.op,
    txid: newMockTxid(),
    network: input.network as MockTxEnvelope["network"],
    signer: null,
    signature: null,
    payload: input.payload,
    inputs: input.inputs,
    outputs: input.outputs,
    feeSats: input.feeSats,
    stateHash: input.stateHash,
    expiresAtHeight: input.expiresAtHeight,
    expiresAtTimestamp: input.expiresAtTimestamp,
  };
}
export function envelopeToPsbt(envelope: MockTxEnvelope): string {
  return Buffer.from(JSON.stringify(envelope, bigintReplacer), "utf8").toString(
    "base64",
  );
}
export function envelopeFromPsbt(psbtBase64: string): MockTxEnvelope {
  return JSON.parse(
    Buffer.from(psbtBase64, "base64").toString("utf8"),
    bigintReviver,
  ) as MockTxEnvelope;
}
export interface SignedEnvelope {
  envelope: MockTxEnvelope;
  signer: string;
}
export function parseSignedMockPsbt(signed: string): SignedEnvelope {
  const lines = signed.split("\n");
  const envelope = envelopeFromPsbt(lines[0]!);
  const marker = lines.slice(1).find((l) => l.startsWith(SIGNATURE_MARKER));
  const signer = marker ? marker.slice(SIGNATURE_MARKER.length).trim() : "";
  return { envelope, signer };
}
export function isMockSignedPsbt(signed: string): boolean {
  return signed.includes(SIGNATURE_MARKER);
}
