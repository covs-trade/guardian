import { sql } from "drizzle-orm";
import type { Database } from "@crclaunch/db";
import type { HealthReport } from "@crclaunch/cove-indexer/v3";
const HEX64 = /^[0-9a-f]{64}$/i;
export function committedHash(raw: string | undefined): string | null {
  const s = (raw ?? "").trim().toLowerCase();
  return HEX64.test(s) ? s : null;
}
export interface IndexerProbeEvaluation {
  indexerHealthy: boolean;
  stateRootVerified: boolean;
  stateRoot: string;
}
export function evaluateIndexerProbe(
  health: HealthReport | null,
  expectedStateRoot: string | null,
): IndexerProbeEvaluation {
  const indexerHealthy = health?.health === "HEALTHY";
  const stateRoot = health?.stateRoot ?? "";
  const stateRootVerified =
    indexerHealthy &&
    expectedStateRoot !== null &&
    stateRoot !== "" &&
    stateRoot.toLowerCase() === expectedStateRoot;
  return { indexerHealthy, stateRootVerified, stateRoot };
}
export function workerLockKey(network: string): number {
  const keys: Record<string, number> = {
    regtest: 1,
    signet: 2,
    testnet: 3,
    mainnet: 4,
  };
  const key = keys[network];
  if (key === undefined)
    throw new Error(`no worker lock key for network "${network}"`);
  return key;
}
export async function probeWorkerLock(
  db: Database,
  network: string,
): Promise<boolean> {
  const key = workerLockKey(network);
  try {
    const res = await db.execute(
      sql`SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND classid = 0 AND objid = ${key} AND objsubid = 1) AS held`,
    );
    const rows = res.rows as Array<{
      held: boolean;
    }>;
    return rows[0]?.held === true;
  } catch {
    return false;
  }
}
