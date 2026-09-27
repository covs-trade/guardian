import { CoreRpcProvider } from "@crclaunch/bitcoin";
import { V3IndexerState } from "./state.js";
import { indexBlocks } from "./worker.js";
import { fullVerify, quickVerify } from "./verify.js";
import type { V3IndexerConfig } from "./types.js";
export interface CliEnv {
  rpcUrl: string;
  rpcUser: string;
  rpcPassword: string;
}
export async function runCli(
  args: string[],
  config: V3IndexerConfig,
  env: CliEnv,
): Promise<void> {
  const provider = new CoreRpcProvider({
    url: env.rpcUrl,
    user: env.rpcUser,
    password: env.rpcPassword,
  });
  const state = new V3IndexerState(config);
  const cmd = args[0] ?? "status";
  switch (cmd) {
    case "reindex": {
      const progress = await indexBlocks(state, provider, config);
      console.log(
        `reindexed to height ${progress.finalHeight} (${progress.indexedBlocks} blocks), root=${progress.stateRoot}`,
      );
      return;
    }
    case "verify": {
      const quick = await quickVerify(state, provider);
      if (!quick.ok) {
        console.log(`verify QUICK: FAIL — ${quick.reason}`);
        process.exitCode = 1;
        return;
      }
      console.log("verify QUICK: PASS");
      if (args.includes("--full")) {
        const full = await fullVerify(state, provider, config);
        console.log(
          `verify FULL: ${full.ok ? "PASS" : `FAIL — ${full.reason}`}`,
        );
        if (!full.ok) process.exitCode = 1;
      }
      return;
    }
    case "status": {
      const info = await provider.getBlockchainInfo();
      const lag = BigInt(info.blocks) - state.cursor.height;
      let aggregateSupply = 0n;
      let aggregateBacking = 0n;
      for (const b of state.backing.values()) {
        aggregateSupply += b.state.issuedPublicSupplyAtoms;
        aggregateBacking += b.state.backingSats;
      }
      console.log(
        JSON.stringify(
          {
            network: config.network,
            coreTip: info.blocks,
            indexedTip: state.cursor.height.toString(),
            lag: lag.toString(),
            indexedTipHash: state.cursor.blockHash,
            stateRoot: state.stateRoot(),
            tokenCount: state.tokens.size,
            unspentTokenUtxoCount: state.tokenUtxos.size,
            aggregateIssuedSupplyAtoms: aggregateSupply.toString(),
            aggregateBackingSats: aggregateBacking.toString(),
            rebuilding: false,
            health: lag > 2n ? "BEHIND" : "OK",
          },
          null,
          2,
        ),
      );
      return;
    }
    default:
      console.error(`unknown command: ${cmd} (expected reindex|verify|status)`);
      process.exitCode = 2;
  }
}
