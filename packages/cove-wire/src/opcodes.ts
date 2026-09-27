export const COVE_PROTOCOL_ID = "crc-20";
export const COVE_WIRE_VERSION = 1;
export const COVE_WIRE_MAGIC = 0x4356;
export const OP_DEPLOY = 0x01;
export const OP_TRANSFER = 0x02;
export const OP_MINT = 0x03;
export const OP_REDEEM = 0x04;
export const MAX_TICKER_BYTES = 16;
export const DATACARRIER_PAYLOAD_LIMIT = 80;
export const COVE_POLICY_V3 = 3;
export function opName(op: number): string {
  switch (op) {
    case OP_DEPLOY:
      return "deploy";
    case OP_TRANSFER:
      return "transfer";
    case OP_MINT:
      return "mint";
    case OP_REDEEM:
      return "redeem";
    default:
      return `unknown(0x${op.toString(16)})`;
  }
}
