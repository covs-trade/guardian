import type { BlockUndo, UndoOp, V3Backing, V3TokenUtxo } from "./types.js";
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function isUtxo(v: unknown): v is V3TokenUtxo {
  return (
    isObj(v) &&
    typeof v.txid === "string" &&
    typeof v.vout === "number" &&
    typeof v.tokenId === "string" &&
    typeof v.amountAtoms === "bigint" &&
    typeof v.scriptPubKey === "string" &&
    typeof v.createdHeight === "bigint" &&
    typeof v.createdBlockHash === "string"
  );
}
function isBacking(v: unknown): v is V3Backing {
  return (
    isObj(v) &&
    typeof v.tokenId === "string" &&
    isObj(v.state) &&
    typeof v.stateHash === "string" &&
    isObj(v.outpoint) &&
    typeof v.outpoint.txid === "string" &&
    typeof v.outpoint.vout === "number" &&
    typeof v.scriptPubKey === "string" &&
    typeof v.btcValue === "bigint" &&
    typeof v.updatedTxid === "string" &&
    typeof v.updatedHeight === "bigint" &&
    typeof v.updatedBlockHash === "string"
  );
}
function assertOp(op: unknown): asserts op is UndoOp {
  if (!isObj(op)) throw new Error("MALFORMED_UNDO: op is not an object");
  switch (op.kind) {
    case "DEPLOY":
      if (typeof op.tokenId !== "string")
        throw new Error("MALFORMED_UNDO: DEPLOY tokenId");
      return;
    case "MINT":
      if (
        typeof op.tokenId !== "string" ||
        !isBacking(op.priorBacking) ||
        !isUtxo(op.createdUtxo)
      )
        throw new Error("MALFORMED_UNDO: MINT fields");
      return;
    case "TRANSFER":
      if (
        typeof op.spendingTxid !== "string" ||
        !Array.isArray(op.spentUtxos) ||
        !op.spentUtxos.every(isUtxo) ||
        !Array.isArray(op.createdUtxos) ||
        !op.createdUtxos.every(isUtxo)
      )
        throw new Error("MALFORMED_UNDO: TRANSFER fields");
      return;
    case "REDEEM":
      if (
        typeof op.tokenId !== "string" ||
        typeof op.spendingTxid !== "string" ||
        !isBacking(op.priorBacking) ||
        !Array.isArray(op.spentUtxos) ||
        !op.spentUtxos.every(isUtxo) ||
        !Array.isArray(op.createdUtxos) ||
        !op.createdUtxos.every(isUtxo)
      )
        throw new Error("MALFORMED_UNDO: REDEEM fields");
      return;
    case "BURN":
      if (
        typeof op.spendingTxid !== "string" ||
        !Array.isArray(op.spentUtxos) ||
        !op.spentUtxos.every(isUtxo)
      )
        throw new Error("MALFORMED_UNDO: BURN fields");
      return;
    default:
      throw new Error(`MALFORMED_UNDO: unknown kind ${String(op.kind)}`);
  }
}
export function encodeUndo(undo: BlockUndo): string {
  return JSON.stringify(undo, (_k, v) =>
    typeof v === "bigint" ? { __bigint: v.toString() } : v,
  );
}
export function decodeUndo(json: string): BlockUndo {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json, (_k, v) => {
      if (
        isObj(v) &&
        typeof v.__bigint === "string" &&
        Object.keys(v).length === 1
      ) {
        return BigInt(v.__bigint);
      }
      return v;
    });
  } catch (e) {
    throw new Error(`MALFORMED_UNDO_JSON: ${(e as Error).message}`);
  }
  if (
    !isObj(parsed) ||
    typeof parsed.height !== "bigint" ||
    typeof parsed.blockHash !== "string" ||
    !Array.isArray(parsed.ops)
  ) {
    throw new Error("MALFORMED_UNDO: top-level shape");
  }
  for (const op of parsed.ops) assertOp(op);
  return parsed as unknown as BlockUndo;
}
