import type { CoveState } from "@crclaunch/protocol";
export interface ProofStep {
  txid: string;
  height: number;
  blockHash: string;
  stateRoot: string;
}
export interface ProofManifest {
  protocol: "cove";
  network: "signet" | "mutinynet";
  ticker: string;
  signerA: string;
  signerB: string;
  deploy?: ProofStep;
  mint?: ProofStep;
  transfer?: ProofStep;
}
export type ProofAction =
  "DEPLOY" | "MINT" | "TRANSFER" | "BLOCKED_UNRESOLVED" | "DONE";
export interface ProofDecision {
  action: ProofAction;
  reason?: string;
}
const TICK_RE = /^[A-Z0-9]{4}$/;
export function validateTicker(t: string): string {
  const v = (t ?? "").trim().toUpperCase();
  if (!TICK_RE.test(v))
    throw new Error(`COVE_PROOF_TICKER must match [A-Z0-9]{4}, got "${t}"`);
  return v;
}
export function decideNextAction(
  manifest: ProofManifest,
  state: CoveState,
  actorScript: string,
  recipientScript: string,
  mintAmountAtoms: bigint,
  transferAmountAtoms: bigint,
): ProofDecision {
  const dep = state.tickerIndex.get(manifest.ticker);
  if (dep === undefined) {
    if (manifest.deploy?.txid) {
      return {
        action: "BLOCKED_UNRESOLVED",
        reason:
          "deploy recorded but not yet confirmed; resolve before re-broadcast",
      };
    }
    return { action: "DEPLOY" };
  }
  if (manifest.deploy?.txid && manifest.deploy.txid !== dep) {
    throw new Error(
      `ticker ${manifest.ticker} is owned by unrelated deployment ${dep}`,
    );
  }
  const aBal = state.balances.get(actorScript)?.get(dep)?.availableAtoms ?? 0n;
  const bBal =
    state.balances.get(recipientScript)?.get(dep)?.availableAtoms ?? 0n;
  const token = state.tokens.get(dep)!;
  const mintDone = token.confirmedSupplyAtoms >= mintAmountAtoms;
  if (!mintDone) {
    return manifest.mint?.txid
      ? {
          action: "BLOCKED_UNRESOLVED",
          reason:
            "mint recorded but not yet confirmed; resolve before re-broadcast",
        }
      : { action: "MINT" };
  }
  if (
    aBal === mintAmountAtoms - transferAmountAtoms &&
    bBal === transferAmountAtoms
  ) {
    return { action: "DONE" };
  }
  return manifest.transfer?.txid
    ? {
        action: "BLOCKED_UNRESOLVED",
        reason:
          "transfer recorded but not yet confirmed; resolve before re-broadcast",
      }
    : { action: "TRANSFER" };
}
