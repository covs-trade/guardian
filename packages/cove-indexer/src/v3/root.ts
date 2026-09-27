import { createHash } from "node:crypto";
import type { V3Backing, V3TokenMeta, V3TokenUtxo } from "./types.js";
export const V3_STATE_ROOT_DOMAIN = "Cove/IndexerState/v3";
function line(parts: string[]): string {
  return parts.join("|");
}
export function computeStateRoot(params: {
  tokens: Map<string, V3TokenMeta>;
  backing: Map<string, V3Backing>;
  tokenUtxos: Map<string, V3TokenUtxo>;
}): string {
  const tokenLines: string[] = [];
  for (const t of [...params.tokens.values()].sort((a, b) =>
    a.tokenId.localeCompare(b.tokenId),
  )) {
    tokenLines.push(
      line([
        "TOKEN",
        t.tokenId,
        t.ticker,
        String(t.policyVersion),
        t.tokenNonce,
        t.deployTxid,
        t.deployHeight.toString(),
        t.creatorScript,
      ]),
    );
  }
  const backingLines: string[] = [];
  for (const b of [...params.backing.values()].sort((a, b) =>
    a.tokenId.localeCompare(b.tokenId),
  )) {
    backingLines.push(
      line([
        "BACKING",
        b.tokenId,
        b.stateHash,
        b.outpoint.txid,
        String(b.outpoint.vout),
        b.btcValue.toString(),
      ]),
    );
  }
  const utxoLines: string[] = [];
  for (const u of [...params.tokenUtxos.values()].sort((a, b) =>
    `${a.txid}:${a.vout}`.localeCompare(`${b.txid}:${b.vout}`),
  )) {
    utxoLines.push(
      line([
        "UTXO",
        u.txid,
        String(u.vout),
        u.tokenId,
        u.amountAtoms.toString(),
        u.scriptPubKey,
      ]),
    );
  }
  const body = [...tokenLines, ...backingLines, ...utxoLines].sort().join("\n");
  return createHash("sha256")
    .update(V3_STATE_ROOT_DOMAIN, "utf8")
    .update("\n")
    .update(body, "utf8")
    .digest("hex");
}
