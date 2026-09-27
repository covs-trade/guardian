import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { createHash } from "node:crypto";
import type { CoveState } from "./types.js";
import { stateHash } from "./state.js";
const COVE_STATE_TAG = "CoveState";
function taggedHash(tag: string, msg: Buffer): Buffer {
  const tagHash = createHash("sha256").update(tag, "utf8").digest();
  return createHash("sha256")
    .update(tagHash)
    .update(tagHash)
    .update(msg)
    .digest();
}
export function stateCommitment(state: CoveState): Buffer {
  return taggedHash(COVE_STATE_TAG, Buffer.from(stateHash(state), "hex"));
}
export function stateTweak(internalKey: Buffer, state: CoveState): Buffer {
  if (internalKey.length !== 32) {
    throw new Error(
      `internalKey must be 32 bytes (x-only), got ${internalKey.length}`,
    );
  }
  return taggedHash(
    "TapTweak",
    Buffer.concat([internalKey, stateCommitment(state)]),
  );
}
export interface StateCommitment {
  outputKey: Buffer;
  scriptPubKeyHex: string;
  address: string;
}
export function deriveStateOutput(
  internalKey: Buffer,
  state: CoveState,
  network: bitcoin.networks.Network = bitcoin.networks.regtest,
): StateCommitment {
  if (internalKey.length !== 32) {
    throw new Error(
      `internalKey must be 32 bytes (x-only), got ${internalKey.length}`,
    );
  }
  const tweak = stateTweak(internalKey, state);
  const tweaked = ecc.xOnlyPointAddTweak(internalKey, tweak);
  if (!tweaked) {
    throw new Error(
      "State tweak produced the point at infinity (invalid for this internal key + state).",
    );
  }
  const outputKey = Buffer.from(tweaked.xOnlyPubkey);
  const scriptPubKeyHex = Buffer.concat([
    Buffer.from([0x51, 0x20]),
    outputKey,
  ]).toString("hex");
  const address = bitcoin.address.toBech32(outputKey, 1, network.bech32);
  return { outputKey, scriptPubKeyHex, address };
}
export function stateOutputScript(
  state: CoveState,
  internalKey: Buffer,
  network?: bitcoin.networks.Network,
): Buffer {
  return Buffer.from(
    deriveStateOutput(internalKey, state, network).scriptPubKeyHex,
    "hex",
  );
}
