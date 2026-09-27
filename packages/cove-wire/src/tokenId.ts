import { createHash } from "node:crypto";
import { canonicalTicker } from "./ticker.js";
export { canonicalTicker };
function taggedHash(tag: string, msg: Buffer): Buffer {
  const tagHash = createHash("sha256").update(tag, "utf8").digest();
  return createHash("sha256")
    .update(tagHash)
    .update(tagHash)
    .update(msg)
    .digest();
}
export const CHAIN_BITCOIN_MAINNET = "bitcoin-mainnet";
export const CHAIN_BITCOIN_REGTEST = "bitcoin-regtest";
export const CHAIN_BITCOIN_SIGNET = "bitcoin-signet";
export const CHAIN_BITCOIN_TESTNET = "bitcoin-testnet";
export interface TokenIdentityInput {
  chainIdentity: string;
  policyVersion: number;
  ticker: string;
  tokenNonce: Buffer;
  creatorScript: Buffer;
}
export function computeTokenId(input: TokenIdentityInput): Buffer {
  const tick = canonicalTicker(input.ticker);
  if (input.tokenNonce.length !== 32) {
    throw new Error("tokenNonce must be 32 bytes");
  }
  if (!Number.isInteger(input.policyVersion) || input.policyVersion < 1) {
    throw new Error("policyVersion must be a positive integer");
  }
  if (input.creatorScript.length === 0 || input.creatorScript.length > 255) {
    throw new Error("creatorScript must be 1..255 bytes");
  }
  return taggedHash(
    "CoveToken",
    Buffer.concat([
      Buffer.from(input.chainIdentity, "utf8"),
      Buffer.from([input.policyVersion]),
      Buffer.from(tick, "utf8"),
      input.tokenNonce,
      Buffer.from([input.creatorScript.length]),
      input.creatorScript,
    ]),
  );
}
export function tokenIdHex(input: TokenIdentityInput): string {
  return computeTokenId(input).toString("hex");
}
