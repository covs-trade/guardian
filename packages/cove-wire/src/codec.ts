import {
  COVE_WIRE_MAGIC,
  COVE_WIRE_VERSION,
  MAX_TICKER_BYTES,
  OP_DEPLOY,
  OP_MINT,
  OP_REDEEM,
  OP_TRANSFER,
} from "./opcodes.js";
export interface DeployEnvelope {
  tick: string;
}
export interface AmountEnvelope {
  op: typeof OP_MINT | typeof OP_REDEEM | typeof OP_TRANSFER;
  amount: bigint;
}
export type ParsedEnvelope =
  | {
      version: number;
      op: typeof OP_DEPLOY;
      tick: string;
    }
  | {
      version: number;
      op: typeof OP_MINT | typeof OP_REDEEM | typeof OP_TRANSFER;
      amount: bigint;
    };
export class WireError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "WireError";
    this.code = code;
  }
}
function header(op: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt16BE(COVE_WIRE_MAGIC, 0);
  b[2] = COVE_WIRE_VERSION;
  b[3] = op;
  return b;
}
export function encodeDeploy(envelope: DeployEnvelope): Buffer {
  const tick = Buffer.from(envelope.tick, "utf8");
  if (tick.length === 0 || tick.length > MAX_TICKER_BYTES) {
    throw new WireError(
      "INVALID_TICKER",
      `ticker must be 1..${MAX_TICKER_BYTES} bytes`,
    );
  }
  if (!/^[A-Za-z0-9]+$/.test(envelope.tick)) {
    throw new WireError("INVALID_TICKER", "ticker must be alphanumeric");
  }
  return Buffer.concat([header(OP_DEPLOY), Buffer.from([tick.length]), tick]);
}
export function encodeAmount(envelope: AmountEnvelope): Buffer {
  if (envelope.amount <= 0n || envelope.amount > 0xffffffffffffffffn) {
    throw new WireError("INVALID_AMOUNT", "amount out of u64 range");
  }
  const amt = Buffer.alloc(8);
  amt.writeBigUInt64BE(envelope.amount, 0);
  return Buffer.concat([header(envelope.op), amt]);
}
function readHeader(payload: Buffer): {
  op: number;
} {
  if (payload.length < 4) {
    throw new WireError("TRUNCATED", "payload shorter than header");
  }
  const magic = payload.readUInt16BE(0);
  if (magic !== COVE_WIRE_MAGIC) {
    throw new WireError(
      "BAD_MAGIC",
      `unexpected magic 0x${magic.toString(16)}`,
    );
  }
  const version = payload[2]!;
  if (version !== COVE_WIRE_VERSION) {
    throw new WireError("BAD_VERSION", `unsupported version ${version}`);
  }
  return { op: payload[3]! };
}
export function decode(payload: Buffer): ParsedEnvelope {
  const { op } = readHeader(payload);
  switch (op) {
    case OP_DEPLOY: {
      if (payload.length < 5)
        throw new WireError("TRUNCATED", "deploy payload too short");
      const tickLen = payload[4]!;
      if (payload.length !== 5 + tickLen) {
        throw new WireError("TRUNCATED", "deploy ticker length mismatch");
      }
      const tick = payload.subarray(5, 5 + tickLen).toString("utf8");
      return { version: COVE_WIRE_VERSION, op, tick };
    }
    case OP_MINT:
    case OP_REDEEM:
    case OP_TRANSFER: {
      if (payload.length !== 12) {
        throw new WireError(
          "TRUNCATED",
          "amount payload must be exactly 12 bytes",
        );
      }
      const amount = payload.readBigUInt64BE(4);
      return { version: COVE_WIRE_VERSION, op, amount };
    }
    default:
      throw new WireError("BAD_OPCODE", `unknown op 0x${op.toString(16)}`);
  }
}
