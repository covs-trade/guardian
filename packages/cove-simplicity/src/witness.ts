import {
  applyMintV2,
  applyRedeemV2,
  stateHashV2,
  type CoveStateV2,
} from "@crclaunch/cove-covenant";
import { ATOMS_PER_TOKEN } from "@crclaunch/curve";
import type { MintWitness, RedeemWitness } from "./simplicity.js";
export interface MintWitnessParams {
  prevState: CoveStateV2;
  nextState: CoveStateV2;
  amountAtoms: bigint;
  canonicalGrossSats: bigint;
}
export interface RedeemWitnessParams {
  prevState: CoveStateV2;
  nextState: CoveStateV2;
  amountAtoms: bigint;
  canonicalGrossSats: bigint;
}
export function atomsToDisplayTokensExact(atoms: bigint): bigint {
  if (atoms < 0n) throw new Error("NEGATIVE_ATOMS");
  if (atoms % ATOMS_PER_TOKEN !== 0n) {
    throw new Error(
      `SUBTOKEN_AMOUNT: ${atoms} is not a whole number of display tokens`,
    );
  }
  return atoms / ATOMS_PER_TOKEN;
}
export function buildMintSimplicityWitness(
  params: MintWitnessParams,
): MintWitness {
  const amount = atomsToDisplayTokensExact(params.amountAtoms);
  const canonical = applyMintV2(params.prevState, params.amountAtoms);
  if (stateHashV2(params.nextState) !== stateHashV2(canonical.nextState)) {
    throw new Error(
      "NEXT_STATE_MISMATCH: successor is not the canonical applyMintV2 result",
    );
  }
  if (params.canonicalGrossSats !== canonical.grossSats) {
    throw new Error(
      "GROSS_MISMATCH: canonicalGrossSats != R(nextSupply) - R(prevSupply)",
    );
  }
  return {
    amount,
    prevSupply: atomsToDisplayTokensExact(
      params.prevState.issuedPublicSupplyAtoms,
    ),
    nextSupply: atomsToDisplayTokensExact(
      canonical.nextState.issuedPublicSupplyAtoms,
    ),
    prevReserve: params.prevState.backingSats,
    nextReserve: canonical.nextState.backingSats,
    contribution: canonical.grossSats,
  };
}
export function buildRedeemSimplicityWitness(
  params: RedeemWitnessParams,
): RedeemWitness {
  const amount = atomsToDisplayTokensExact(params.amountAtoms);
  const canonical = applyRedeemV2(params.prevState, params.amountAtoms);
  if (stateHashV2(params.nextState) !== stateHashV2(canonical.nextState)) {
    throw new Error(
      "NEXT_STATE_MISMATCH: successor is not the canonical applyRedeemV2 result",
    );
  }
  if (params.canonicalGrossSats !== canonical.grossSats) {
    throw new Error(
      "GROSS_MISMATCH: canonicalGrossSats != R(prevSupply) - R(nextSupply)",
    );
  }
  return {
    amount,
    oldSupply: atomsToDisplayTokensExact(
      params.prevState.issuedPublicSupplyAtoms,
    ),
    newSupply: atomsToDisplayTokensExact(
      canonical.nextState.issuedPublicSupplyAtoms,
    ),
    oldBacking: params.prevState.backingSats,
    newBacking: canonical.nextState.backingSats,
    payout: canonical.grossSats,
  };
}
