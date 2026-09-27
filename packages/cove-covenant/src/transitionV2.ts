import {
  ATOMS_PER_TOKEN,
  LOT_TOKENS,
  PUBLIC_SUPPLY_ATOMS,
} from "@crclaunch/curve";
const LOT_ATOMS = LOT_TOKENS * ATOMS_PER_TOKEN;
import type { Atoms, Sats } from "@crclaunch/curve";
import { requiredBackingSats } from "@crclaunch/cove-economics";
import { COVE_POLICY_V3 } from "@crclaunch/cove-wire";
import { impliedStageV2, type CoveStateV2 } from "./stateV2.js";
import { CovenantError } from "./transition.js";
export function validateStateV2(state: CoveStateV2): void {
  if (state.stateVersion !== 2)
    throw new CovenantError("BAD_STATE_VERSION", "stateVersion must be 2");
  if (state.policyVersion !== COVE_POLICY_V3) {
    throw new CovenantError(
      "BAD_POLICY_VERSION",
      `policyVersion must be ${COVE_POLICY_V3}`,
    );
  }
  if (!/^[0-9a-f]{64}$/.test(state.tokenId) || /^0{64}$/.test(state.tokenId)) {
    throw new CovenantError(
      "INVALID_TOKEN_ID",
      "tokenId must be nonzero 32 bytes",
    );
  }
  if (
    state.issuedPublicSupplyAtoms < 0n ||
    state.issuedPublicSupplyAtoms > PUBLIC_SUPPLY_ATOMS
  ) {
    throw new CovenantError(
      "SUPPLY_OUT_OF_RANGE",
      "issued supply out of range",
    );
  }
  if (state.issuedPublicSupplyAtoms % ATOMS_PER_TOKEN !== 0n) {
    throw new CovenantError(
      "SUPPLY_NOT_ATOMIC",
      "issued supply is not a whole display token",
    );
  }
  if (state.issuedPublicSupplyAtoms % LOT_ATOMS !== 0n) {
    throw new CovenantError(
      "SUPPLY_NOT_LOTS",
      "issued supply is not a whole number of lots",
    );
  }
  const implied = impliedStageV2(state.issuedPublicSupplyAtoms);
  if (state.curveStage !== implied) {
    throw new CovenantError(
      "CURVE_STAGE_MISMATCH",
      `curveStage ${state.curveStage} != implied ${implied}`,
    );
  }
  const backing = requiredBackingSats(
    state.issuedPublicSupplyAtoms / ATOMS_PER_TOKEN,
  );
  if (state.backingSats !== backing) {
    throw new CovenantError(
      "BACKING_MISMATCH",
      `backingSats ${state.backingSats} != R(supply) ${backing}`,
    );
  }
}
export interface MintV2Result {
  nextState: CoveStateV2;
  grossSats: Sats;
}
export interface RedeemV2Result {
  nextState: CoveStateV2;
  grossSats: Sats;
}
export function s0StateV2(params: { tokenId: string }): CoveStateV2 {
  return {
    stateVersion: 2,
    policyVersion: COVE_POLICY_V3,
    tokenId: params.tokenId,
    issuedPublicSupplyAtoms: 0n,
    backingSats: 0n,
    curveStage: impliedStageV2(0n),
  };
}
export function applyMintV2(
  prev: CoveStateV2,
  amountAtoms: Atoms,
): MintV2Result {
  validateStateV2(prev);
  if (amountAtoms <= 0n)
    throw new CovenantError("ZERO_MINT", "amount must be positive");
  if (amountAtoms % ATOMS_PER_TOKEN !== 0n)
    throw new CovenantError("SUBTOKEN_MINT", "amount must be whole token");
  if (amountAtoms % LOT_ATOMS !== 0n)
    throw new CovenantError(
      "NOT_WHOLE_LOTS",
      `mint whole lots of ${LOT_TOKENS} tokens`,
    );
  const nextSupply = prev.issuedPublicSupplyAtoms + amountAtoms;
  if (nextSupply > PUBLIC_SUPPLY_ATOMS)
    throw new CovenantError("OVERMINT", "exceeds public cap");
  const prevTokens = prev.issuedPublicSupplyAtoms / ATOMS_PER_TOKEN;
  const nextTokens = nextSupply / ATOMS_PER_TOKEN;
  const gross =
    requiredBackingSats(nextTokens) - requiredBackingSats(prevTokens);
  if (gross < 1n) throw new CovenantError("ECONOMIC_DUST", "zero R-delta");
  return {
    grossSats: gross,
    nextState: {
      ...prev,
      issuedPublicSupplyAtoms: nextSupply,
      backingSats: requiredBackingSats(nextTokens),
      curveStage: impliedStageV2(nextSupply),
    },
  };
}
export function applyRedeemV2(
  prev: CoveStateV2,
  amountAtoms: Atoms,
): RedeemV2Result {
  validateStateV2(prev);
  if (amountAtoms <= 0n)
    throw new CovenantError("ZERO_REDEEM", "amount must be positive");
  if (amountAtoms % ATOMS_PER_TOKEN !== 0n)
    throw new CovenantError("SUBTOKEN_REDEEM", "amount must be whole token");
  if (amountAtoms % LOT_ATOMS !== 0n)
    throw new CovenantError(
      "NOT_WHOLE_LOTS",
      `redeem whole lots of ${LOT_TOKENS} tokens`,
    );
  if (amountAtoms > prev.issuedPublicSupplyAtoms)
    throw new CovenantError(
      "REDEEM_EXCEEDS_SUPPLY",
      "amount exceeds issued supply",
    );
  const nextSupply = prev.issuedPublicSupplyAtoms - amountAtoms;
  const prevTokens = prev.issuedPublicSupplyAtoms / ATOMS_PER_TOKEN;
  const nextTokens = nextSupply / ATOMS_PER_TOKEN;
  const gross =
    requiredBackingSats(prevTokens) - requiredBackingSats(nextTokens);
  if (gross < 1n) throw new CovenantError("ECONOMIC_DUST", "zero R-delta");
  return {
    grossSats: gross,
    nextState: {
      ...prev,
      issuedPublicSupplyAtoms: nextSupply,
      backingSats: requiredBackingSats(nextTokens),
      curveStage: impliedStageV2(nextSupply),
    },
  };
}
