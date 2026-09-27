import type { CoveStateV2 } from "@crclaunch/cove-covenant";
import {
  buildMintSimplicityWitness,
  buildRedeemSimplicityWitness,
  type MintWitness,
  type RedeemWitness,
} from "@crclaunch/cove-simplicity";
export interface WitnessOk<T> {
  ok: true;
  witness: T;
}
export interface WitnessErr {
  ok: false;
  detail: string;
}
export type WitnessResult<T> = WitnessOk<T> | WitnessErr;
export function buildCanonicalMintWitness(params: {
  prevState: CoveStateV2;
  nextState: CoveStateV2;
  amountAtoms: bigint;
  canonicalGrossSats: bigint;
}): WitnessResult<MintWitness> {
  try {
    return { ok: true, witness: buildMintSimplicityWitness(params) };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}
export function buildCanonicalRedeemWitness(params: {
  prevState: CoveStateV2;
  nextState: CoveStateV2;
  amountAtoms: bigint;
  canonicalGrossSats: bigint;
}): WitnessResult<RedeemWitness> {
  try {
    return { ok: true, witness: buildRedeemSimplicityWitness(params) };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}
