import {
  quoteExactTokens,
  TOTAL_SUPPLY_TOKENS,
  PUBLIC_SUPPLY_TOKENS,
  GRADUATION_RESERVE_TOKENS,
  getStageForSupply,
} from "@crclaunch/curve";
import type { MockChainNode } from "./node.js";
import type { MockToken } from "./types.js";
interface SeedSpec {
  ticker: string;
  name: string;
  percentMinted: number;
  graduated?: boolean;
}
const SEED: SeedSpec[] = [
  { ticker: "FROG", name: "Frog", percentMinted: 63 },
  { ticker: "DOGE", name: "Doge", percentMinted: 28 },
  { ticker: "MOON", name: "Moon", percentMinted: 96 },
  { ticker: "TREE", name: "Tree", percentMinted: 100, graduated: true },
];
export async function seedMockChain(node: MockChainNode): Promise<void> {
  await node.mutate((state) => {
    for (const spec of SEED) {
      const deploymentId = `seed-${spec.ticker.toLowerCase()}-00000000000000000000000000000000`;
      if (state.tokens[deploymentId]) continue;
      const minted = (PUBLIC_SUPPLY_TOKENS * BigInt(spec.percentMinted)) / 100n;
      const reserve = quoteExactTokens({
        desiredTokens: minted,
        currentSupply: 0n,
      }).curveContributionSats;
      const token: MockToken = {
        deploymentId,
        ticker: spec.ticker,
        tickerNormalized: spec.ticker,
        name: spec.name,
        creatorAddress: `bc1qm0ckseed-${spec.ticker.toLowerCase()}000000000000000000000000000`,
        network: state.network,
        totalSupplyAtoms: TOTAL_SUPPLY_TOKENS,
        publicSupplyAtoms: PUBLIC_SUPPLY_TOKENS,
        reserveSupplyAtoms: GRADUATION_RESERVE_TOKENS,
        confirmedMintedAtoms: minted,
        pendingMintedAtoms: 0n,
        currentStage: getStageForSupply(minted),
        deployHeight: 1n,
        status: spec.graduated ? "GRADUATED" : "LIVE",
        reserveSats: reserve,
        lastTradePricePerMillion: spec.graduated ? 149731n : null,
      };
      state.tokens[deploymentId] = token;
      state.tickerIndex[spec.ticker] = deploymentId;
    }
  });
}
