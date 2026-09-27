import { createHash } from "node:crypto";
import type { CoveState } from "./types.js";
const SECTION_SEP = "\n---\n";
function sortRecords(records: string[]): string[] {
  return records.sort();
}
export function referenceComputeStateRoot(
  state: CoveState,
  domain: string,
): string {
  const tokenRecords: string[] = [];
  for (const [id, token] of state.tokens) {
    tokenRecords.push(
      `${id}:${token.ticker}:${token.creator}:${token.confirmedSupplyAtoms}:${token.currentStage}`,
    );
  }
  const tokensSection = sortRecords(tokenRecords).join("\n");
  const tickerRecords: string[] = [];
  for (const [ticker, id] of state.tickerIndex) {
    tickerRecords.push(`${ticker}:${id}`);
  }
  const tickerSection = sortRecords(tickerRecords).join("\n");
  const balanceRecords: string[] = [];
  for (const [owner, byDep] of state.balances) {
    for (const [dep, balance] of byDep) {
      balanceRecords.push(`${owner}:${dep}:${balance.availableAtoms}`);
    }
  }
  const balancesSection = sortRecords(balanceRecords).join("\n");
  const payload = [
    domain,
    tokensSection,
    tickerSection,
    balancesSection,
    String(state.reserveSats),
    String(state.platformTreasurySats),
  ].join(SECTION_SEP);
  return createHash("sha256").update(payload).digest("hex");
}
