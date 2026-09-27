import { createHash } from "node:crypto";
import type { CoveState } from "./types.js";
export function computeStateRoot(state: CoveState, domain: string): string {
  const tokens = [...state.tokens.entries()]
    .map(
      ([id, t]) =>
        `${id}:${t.ticker}:${t.creator}:${t.confirmedSupplyAtoms}:${t.currentStage}`,
    )
    .sort()
    .join("\n");
  const tickerIndex = [...state.tickerIndex.entries()]
    .map(([tick, id]) => `${tick}:${id}`)
    .sort()
    .join("\n");
  const balances = [...state.balances.entries()]
    .flatMap(([owner, m]) =>
      [...m.entries()].map(([dep, b]) => `${owner}:${dep}:${b.availableAtoms}`),
    )
    .sort()
    .join("\n");
  const payload = [
    domain,
    tokens,
    tickerIndex,
    balances,
    state.reserveSats.toString(),
    state.platformTreasurySats.toString(),
  ].join("\n---\n");
  return createHash("sha256").update(payload).digest("hex");
}
