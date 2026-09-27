import { schema, type Database } from "@crclaunch/db";
import { eq } from "drizzle-orm";
import type { CoreRpcProvider } from "@crclaunch/bitcoin";
import { computeHealth } from "@crclaunch/cove-indexer/v3";
import type { V3AppConfig } from "./config.js";
export interface V3Status {
  network: string;
  appEnabled: boolean;
  core: {
    reachable: boolean;
    height: bigint;
    tip: string;
  };
  indexer: {
    health: string;
    indexedHeight: bigint;
    indexedBlockHash: string;
    stateRoot: string;
    lag: bigint;
    rebuilding: boolean;
  };
  guardian: {
    configured: boolean;
  };
  market: {
    enabled: boolean;
  };
}
export async function getV3Status(params: {
  db: Database;
  provider: CoreRpcProvider;
  config: V3AppConfig;
}): Promise<V3Status> {
  const { db, provider, config } = params;
  const health = await computeHealth({ db, network: config.network, provider });
  let coreReachable = true;
  let coreHeight = health.coreHeight;
  let tip = health.coreBlockHashAtCursor ?? "";
  if (health.health === "CORE_UNREACHABLE") {
    coreReachable = false;
    coreHeight = 0n;
    tip = "";
  } else {
    try {
      const info = await provider.getBlockchainInfo();
      coreHeight = BigInt(info.blocks);
      tip = info.bestBlockHash;
    } catch {
      coreReachable = false;
    }
  }
  const marketFlag = await db
    .select()
    .from(schema.featureFlags)
    .where(eq(schema.featureFlags.id, "cove-v3-market"));
  return {
    network: config.network,
    appEnabled: config.enabled,
    core: { reachable: coreReachable, height: coreHeight, tip },
    indexer: {
      health: health.health,
      indexedHeight: health.cursorHeight,
      indexedBlockHash: health.cursorBlockHash,
      stateRoot: health.stateRoot,
      lag: health.lag,
      rebuilding: health.rebuilding,
    },
    guardian: { configured: config.guardianPrivateKey !== null },
    market: { enabled: marketFlag[0]?.enabled ?? true },
  };
}
