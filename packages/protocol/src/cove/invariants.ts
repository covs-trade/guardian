import type { CoveState } from "./types.js";
export function assertCoveInvariants(state: CoveState): void {
  for (const [deploymentId, token] of state.tokens) {
    if (
      token.confirmedSupplyAtoms < 0n ||
      token.confirmedSupplyAtoms > token.publicSupplyAtoms
    ) {
      throw new Error(`token ${token.ticker}: supply out of range`);
    }
    if (state.tickerIndex.get(token.ticker) !== deploymentId) {
      throw new Error(`token ${token.ticker}: ticker index mismatch`);
    }
    let sum = 0n;
    for (const balances of state.balances.values()) {
      const b = balances.get(deploymentId);
      if (!b) continue;
      if (b.availableAtoms < 0n) {
        throw new Error(`token ${token.ticker}: negative balance`);
      }
      sum += b.availableAtoms;
    }
    if (sum !== token.confirmedSupplyAtoms) {
      throw new Error(
        `token ${token.ticker}: conservation violated (Σ balances ${sum} != confirmed ${token.confirmedSupplyAtoms})`,
      );
    }
  }
}
