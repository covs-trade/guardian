import type { BitcoinChainProvider } from "@crclaunch/bitcoin";
export const SIGNET_GENESIS_HASH =
  "00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6";
export const MAINNET_GENESIS_HASH =
  "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f";
export function isSignetGenesis(hash: string): boolean {
  return hash.toLowerCase() === SIGNET_GENESIS_HASH;
}
export function isMainnetGenesis(hash: string): boolean {
  return hash.toLowerCase() === MAINNET_GENESIS_HASH;
}
export function assertFutureActivationHeight(
  H: number,
  currentTip: number,
): void {
  if (!Number.isInteger(H) || H < 1) {
    throw new Error(`activation height must be a positive integer, got ${H}`);
  }
  if (H <= currentTip) {
    throw new Error(
      `activation height ${H} must be in the future (current tip ${currentTip})`,
    );
  }
}
export async function assertSignetChain(
  provider: Pick<BitcoinChainProvider, "getBlockHash">,
): Promise<void> {
  const genesis = await provider.getBlockHash(0);
  if (!isSignetGenesis(genesis)) {
    throw new Error(
      `genesis block hash ${genesis} is not signet (${SIGNET_GENESIS_HASH}); refusing to proceed on a non-signet chain`,
    );
  }
}
export async function assertMainnetChain(
  provider: Pick<BitcoinChainProvider, "getBlockHash">,
): Promise<void> {
  const genesis = await provider.getBlockHash(0);
  if (!isMainnetGenesis(genesis)) {
    throw new Error(
      `genesis block hash ${genesis} is not mainnet (${MAINNET_GENESIS_HASH}); refusing to broadcast`,
    );
  }
}
