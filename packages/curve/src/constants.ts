import type { Atoms, BasisPoints, DisplayTokens, Sats } from "./types.js";
export const DECIMALS = 8;
export const ATOMS_PER_TOKEN: Atoms = 10n ** BigInt(DECIMALS);
export const TOTAL_SUPPLY_TOKENS: DisplayTokens = 21000000n;
export const PUBLIC_SUPPLY_TOKENS: DisplayTokens = 21000000n;
export const GRADUATION_RESERVE_TOKENS: DisplayTokens = 0n;
export const RESERVE_SUPPLY_TOKENS: DisplayTokens = GRADUATION_RESERVE_TOKENS;
export const CREATOR_PREMINE_TOKENS: DisplayTokens = 0n;
export const TEAM_ALLOCATION_TOKENS: DisplayTokens = 0n;
export const STAGE_COUNT = 210;
export const TOKENS_PER_STAGE: DisplayTokens = 100000n;
export const LOT_TOKENS: DisplayTokens = 1000n;
export const LOT_BASE_SATS: Sats = 27n;
export const LOT_STEP_SATS: Sats = 27n;
export const PRICE_UNIT_TOKENS: DisplayTokens = 1000000n;
export const TOTAL_SUPPLY_ATOMS: Atoms = TOTAL_SUPPLY_TOKENS * ATOMS_PER_TOKEN;
export const PUBLIC_SUPPLY_ATOMS: Atoms =
  PUBLIC_SUPPLY_TOKENS * ATOMS_PER_TOKEN;
export const GRADUATION_RESERVE_ATOMS: Atoms =
  GRADUATION_RESERVE_TOKENS * ATOMS_PER_TOKEN;
export const RESERVE_SUPPLY_ATOMS: Atoms = GRADUATION_RESERVE_ATOMS;
export const TOKENS_PER_STAGE_ATOMS: Atoms = TOKENS_PER_STAGE * ATOMS_PER_TOKEN;
export const PRICE_UNIT_ATOMS: Atoms = PRICE_UNIT_TOKENS * ATOMS_PER_TOKEN;
export const MIN_CONTRIBUTION_SATS: Sats = 1000n;
export const PRIMARY_MINT_FEE_BPS: BasisPoints = 100n;
export const STAGE_PRICES_SATS_PER_MILLION: readonly Sats[] = Object.freeze(
  Array.from(
    { length: STAGE_COUNT },
    (_, i) =>
      (LOT_BASE_SATS + LOT_STEP_SATS * BigInt(i)) *
      (PRICE_UNIT_TOKENS / LOT_TOKENS),
  ),
);
