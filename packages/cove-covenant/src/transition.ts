import {
  ATOMS_PER_TOKEN,
  PUBLIC_SUPPLY_ATOMS,
  getStageForSupply,
} from "@crclaunch/curve";
import type { Atoms, Sats } from "@crclaunch/curve";
import { BackingError, grossBuy, grossRedeem } from "@crclaunch/cove-economics";
import type { CoveState } from "./types.js";
export class CovenantError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CovenantError";
    this.code = code;
  }
}
export function isCovenantError(e: unknown): e is CovenantError {
  return e instanceof CovenantError;
}
export interface MintResult {
  nextState: CoveState;
  curveContributionSats: Sats;
}
export interface RedeemResult {
  nextState: CoveState;
  grossRedeemSats: Sats;
}
export function applyMint(prev: CoveState, amountAtoms: Atoms): MintResult {
  if (amountAtoms <= 0n) {
    throw new CovenantError("ZERO_MINT", "Minted amount must be positive.");
  }
  if (amountAtoms % ATOMS_PER_TOKEN !== 0n) {
    throw new CovenantError(
      "SUBTOKEN_MINT",
      "Minted amount must be a whole display token.",
    );
  }
  const amountTokens = amountAtoms / ATOMS_PER_TOKEN;
  const supplyTokens = prev.publicSupplyAtoms / ATOMS_PER_TOKEN;
  const nextSupplyAtoms = prev.publicSupplyAtoms + amountAtoms;
  if (nextSupplyAtoms > PUBLIC_SUPPLY_ATOMS) {
    throw new CovenantError(
      "OVERMINT",
      `Mint would exceed public supply (${nextSupplyAtoms} > ${PUBLIC_SUPPLY_ATOMS}).`,
    );
  }
  let curveContributionSats: Sats;
  try {
    curveContributionSats = grossBuy(supplyTokens, amountTokens);
  } catch (e) {
    if (e instanceof BackingError) {
      throw new CovenantError(
        e.code === "ECONOMIC_DUST" ? "ECONOMIC_DUST" : "OVERMINT",
        e.message,
      );
    }
    throw e;
  }
  return {
    curveContributionSats,
    nextState: {
      ...prev,
      publicSupplyAtoms: nextSupplyAtoms,
      reserveSats: prev.reserveSats + curveContributionSats,
      curveStage: getStageForSupply(nextSupplyAtoms / ATOMS_PER_TOKEN),
    },
  };
}
export function applyRedeem(prev: CoveState, amountAtoms: Atoms): RedeemResult {
  if (amountAtoms <= 0n) {
    throw new CovenantError("ZERO_REDEEM", "Redeemed amount must be positive.");
  }
  if (amountAtoms % ATOMS_PER_TOKEN !== 0n) {
    throw new CovenantError(
      "SUBTOKEN_REDEEM",
      "Redeemed amount must be a whole display token.",
    );
  }
  const amountTokens = amountAtoms / ATOMS_PER_TOKEN;
  const supplyTokens = prev.publicSupplyAtoms / ATOMS_PER_TOKEN;
  if (amountAtoms > prev.publicSupplyAtoms) {
    throw new CovenantError(
      "INSUFFICIENT_TOKEN_BALANCE",
      "Redeem exceeds issued supply.",
    );
  }
  let gross;
  try {
    gross = grossRedeem(supplyTokens, amountTokens);
  } catch (e) {
    if (e instanceof BackingError) {
      throw new CovenantError(e.code, e.message);
    }
    throw e;
  }
  const nextSupplyAtoms = prev.publicSupplyAtoms - amountAtoms;
  return {
    grossRedeemSats: gross,
    nextState: {
      ...prev,
      publicSupplyAtoms: nextSupplyAtoms,
      reserveSats: prev.reserveSats - gross,
      curveStage: getStageForSupply(nextSupplyAtoms / ATOMS_PER_TOKEN),
    },
  };
}
export function isCorrectMintSuccessor(
  prev: CoveState,
  amountAtoms: Atoms,
  proposed: CoveState,
): boolean {
  try {
    const { nextState } = applyMint(prev, amountAtoms);
    return serializeCoveStateEq(nextState, proposed);
  } catch {
    return false;
  }
}
function serializeCoveStateEq(a: CoveState, b: CoveState): boolean {
  return (
    a.version === b.version &&
    a.tokenId === b.tokenId &&
    a.phase === b.phase &&
    a.publicSupplyAtoms === b.publicSupplyAtoms &&
    a.reserveSats === b.reserveSats &&
    a.curveStage === b.curveStage
  );
}
