import { CoreRpcProvider } from "@crclaunch/bitcoin";
import { createDb } from "@crclaunch/db";
import { regtestConfig } from "./testing/regtest-fixture.js";
import { V3Store } from "./store.js";
import { hydrateState } from "./hydrate.js";
import { reindexDb } from "./reindex.js";
import { computeHealth } from "./health.js";
import { quickVerify, fullVerify } from "./verify.js";
const RPC_URL = process.env.COVE_REGTEST_RPC_URL ?? "http://127.0.0.1:18443";
const RPC_USER = process.env.COVE_REGTEST_RPC_USER ?? "user";
const RPC_PASSWORD = process.env.COVE_REGTEST_RPC_PASSWORD ?? "pass";
const DB_URL = process.env.COVE_DATABASE_URL ?? process.env.DATABASE_URL;
async function main() {
  if (!DB_URL)
    throw new Error("DATABASE_URL is required for persistent CLI commands");
  const db = createDb(DB_URL);
  const provider = new CoreRpcProvider({
    url: RPC_URL,
    user: RPC_USER,
    password: RPC_PASSWORD,
  });
  const cfg = regtestConfig();
  const store = new V3Store("regtest");
  const cmd = process.argv[2] ?? "status";
  switch (cmd) {
    case "status": {
      const state = await hydrateState(db, "regtest", cfg);
      const health = await computeHealth({ db, network: "regtest", provider });
      let aggregateSupply = 0n;
      let aggregateBacking = 0n;
      for (const b of state.backing.values()) {
        aggregateSupply += b.state.issuedPublicSupplyAtoms;
        aggregateBacking += b.state.backingSats;
      }
      console.log(
        JSON.stringify(
          {
            network: "regtest",
            coreTip: health.coreHeight.toString(),
            dbTip: health.cursorHeight.toString(),
            lag: health.lag.toString(),
            dbTipHash: health.cursorBlockHash,
            stateRoot: state.stateRoot(),
            tokenCount: state.tokens.size,
            unspentTokenUtxoCount: state.tokenUtxos.size,
            aggregateIssuedSupplyAtoms: aggregateSupply.toString(),
            aggregateBackingSats: aggregateBacking.toString(),
            rebuilding: health.rebuilding,
            health: health.health,
          },
          null,
          2,
        ),
      );
      return;
    }
    case "verify": {
      const state = await hydrateState(db, "regtest", cfg);
      const quick = await quickVerify(state, provider);
      console.log(
        `verify QUICK: ${quick.ok ? "PASS" : `FAIL — ${quick.reason}`}`,
      );
      if (!quick.ok) {
        process.exitCode = 1;
        return;
      }
      if (process.argv.includes("--full")) {
        const full = await fullVerify(state, provider, cfg);
        console.log(
          `verify FULL: ${full.ok ? "PASS" : `FAIL — ${full.reason}`}`,
        );
        if (!full.ok) process.exitCode = 1;
      }
      return;
    }
    case "reindex": {
      const result = await reindexDb({
        db,
        store,
        provider,
        config: cfg,
        network: "regtest",
      });
      console.log(
        `reindexed to height ${result.finalHeight}, root=${result.stateRoot}`,
      );
      return;
    }
    default:
      console.error(`unknown command: ${cmd} (expected status|verify|reindex)`);
      process.exitCode = 2;
  }
}
main().catch((e) => {
  console.error("v3 cli failed:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
