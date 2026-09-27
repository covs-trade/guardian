export interface Crc20Payload {
  p: string;
  op: string;
  tick: string;
  amt?: string;
  [key: string]: unknown;
}
export function decodeCrc20Json(json: string): Crc20Payload | null {
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    if (typeof parsed.p !== "string" || parsed.p !== "crc-20") return null;
    if (typeof parsed.op !== "string") return null;
    if (typeof parsed.tick !== "string") return null;
    return parsed as unknown as Crc20Payload;
  } catch {
    return null;
  }
}
export function decodeCrc20OpReturn(
  scriptPubKeyHex: string,
): Crc20Payload | null {
  const spk = Buffer.from(scriptPubKeyHex, "hex");
  if (spk.length < 2 || spk[0] !== 0x6a) return null;
  let offset = 1;
  let len = spk[offset];
  if (len === undefined) return null;
  offset += 1;
  if (len === 0x4c) {
    len = spk[offset];
    offset += 1;
  } else if (len === 0x4d) {
    len = spk.readUInt16LE(offset);
    offset += 2;
  } else if (len === 0x4e) {
    len = spk.readUInt32LE(offset);
    offset += 4;
  }
  if (len === undefined) return null;
  const payload = spk.subarray(offset, offset + len).toString("utf8");
  return decodeCrc20Json(payload.trim());
}
export const OBSERVED_LEAF_TRANSFER = {
  txid: "e0b7e317a6311432bd3f03e9f8536b4dfed0625ddf5b96f5b1c6bc25bdb8ee2f",
  blockHeight: 968175,
  opReturnHex:
    "6a437b2270223a226372632d3230222c226f70223a227472616e73666572222c227469636b223a224c454146222c22616d74223a223130303030303030303030303030227d",
  payload: { p: "crc-20", op: "transfer", tick: "LEAF", amt: "10000000000000" },
  recipientAddress: "bc1qyztrfnc86g5hpcmn4k8j0ztufxre7q5k3ajxzs",
  recipientSats: 294,
  treasuryAddress:
    "bc1pv85mk7dh9ea4ylsamzvcwsseglj7smph8rm8hz8ksxg4d5q43u8selta0j",
  treasurySats: 1347,
  treasuryScriptPubKey:
    "512061e9bb79b72e7b527e1dd89987421947e5e86c3738f67b88f6819156d0158f0f",
} as const;
