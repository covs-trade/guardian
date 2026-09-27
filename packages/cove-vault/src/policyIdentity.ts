import { taggedHash } from "./taproot.js";
export const COVE_PROTOCOL_VERSION = 1;
export const OP_MINT = 0x03;
export const OP_REDEEM = 0x04;
export const COVE_POLICY_V1 = 1;
export const COVE_POLICY_V2 = 2;
export const COVE_POLICY_V3 = 3;
export interface PolicyCmrs {
  mint: string;
  redeem?: string;
}
export const COVE_POLICY_CMRS: Record<number, PolicyCmrs> = {
  [COVE_POLICY_V1]: {
    mint: "118425967f4aed4fb528bd06a0f7a99a318675e819e837a2c452df6199d359b2",
  },
  [COVE_POLICY_V2]: {
    mint: "118425967f4aed4fb528bd06a0f7a99a318675e819e837a2c452df6199d359b2",
    redeem: "a15ac4cbc450ac2dd113b1a9de178450ccc893a5213d8a2f56471fcd9aa274b7",
  },
  [COVE_POLICY_V3]: {
    mint: "7fb27adf2db5458882daf976ba9325815f111b2f3b16eedb72e75f96de4269b2",
    redeem: "37e681b3e70a34acc3b38680c06fbe4f1b2799bede2607c6c9ed7fcac8c95d56",
  },
};
export interface PolicyIdentity {
  version: number;
  operation: number;
  tokenId: string;
  currentStateHash: Buffer;
  cmr: Buffer;
}
export function policyIdentityHash(p: PolicyIdentity): Buffer {
  if (!/^[0-9a-f]{64}$/.test(p.tokenId)) {
    throw new Error("tokenId must be 64 hex chars");
  }
  if (p.currentStateHash.length !== 32) {
    throw new Error("currentStateHash must be 32 bytes");
  }
  if (p.cmr.length !== 32) {
    throw new Error("cmr must be 32 bytes");
  }
  return taggedHash(
    "CovePolicy",
    Buffer.concat([
      Buffer.from([p.version]),
      Buffer.from([p.operation]),
      Buffer.from(p.tokenId, "hex"),
      p.currentStateHash,
      p.cmr,
    ]),
  );
}
