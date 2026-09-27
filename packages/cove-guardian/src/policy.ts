import {
  COVE_STATE_VERSION,
  applyMint,
  deserializeState,
  serializeState,
  stateHash,
  type CoveState,
} from "@crclaunch/cove-covenant";
import {
  ATOMS_PER_TOKEN,
  PUBLIC_SUPPLY_ATOMS,
  getStageForSupply,
} from "@crclaunch/curve";
import type { Atoms, Sats } from "@crclaunch/curve";
export class GuardianError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "GuardianError";
    this.code = code;
  }
}
export type GuardianNetwork = "mainnet" | "signet" | "regtest" | "testnet";
export interface MintContext {
  prevState: CoveState;
  nextState: CoveState;
  amountAtoms: Atoms;
  curveContributionSats: Sats;
  feeSats: Sats;
  recipientCommitment: Buffer;
  network: GuardianNetwork;
}
export interface GuardianDecision {
  ok: boolean;
  reason?: string;
}
export const MAX_FEE_SATS = 50000n;
export function isWellFormedCommitment(script: Buffer): boolean {
  const hex = script.toString("hex");
  return /^5120[0-9a-f]{64}$/.test(hex) || /^0014[0-9a-f]{40}$/.test(hex);
}
export function validateStateInvariants(
  state: CoveState,
  operation?: "MINT",
): GuardianDecision {
  if (state.version !== COVE_STATE_VERSION) {
    return { ok: false, reason: "INVALID_STATE_VERSION" };
  }
  if (!/^[0-9a-f]{64}$/.test(state.tokenId)) {
    return { ok: false, reason: "INVALID_TOKEN_ID" };
  }
  if (/^0{64}$/.test(state.tokenId)) {
    return { ok: false, reason: "INVALID_TOKEN_ID" };
  }
  if (
    state.publicSupplyAtoms < 0n ||
    state.publicSupplyAtoms > PUBLIC_SUPPLY_ATOMS
  ) {
    return { ok: false, reason: "SUPPLY_OUT_OF_RANGE" };
  }
  if (state.publicSupplyAtoms % ATOMS_PER_TOKEN !== 0n) {
    return { ok: false, reason: "SUPPLY_NOT_ATOMIC" };
  }
  let impliedStage: number;
  try {
    impliedStage = getStageForSupply(state.publicSupplyAtoms / ATOMS_PER_TOKEN);
  } catch {
    return { ok: false, reason: "SUPPLY_OUT_OF_RANGE" };
  }
  if (state.curveStage !== impliedStage) {
    return { ok: false, reason: "CURVE_STAGE_MISMATCH" };
  }
  if (state.reserveSats < 0n) {
    return { ok: false, reason: "RESERVE_NEGATIVE" };
  }
  if (operation === "MINT" && state.phase !== "PUBLIC_MINT") {
    return { ok: false, reason: "PHASE_NOT_PUBLIC_MINT" };
  }
  return { ok: true };
}
function consistentState(s: CoveState): boolean {
  try {
    return serializeState(deserializeState(serializeState(s))).length > 0;
  } catch {
    return false;
  }
}
export function validateMint(ctx: MintContext): GuardianDecision {
  const {
    prevState,
    nextState,
    amountAtoms,
    curveContributionSats,
    feeSats,
    recipientCommitment,
    network,
  } = ctx;
  if (!consistentState(prevState)) {
    return { ok: false, reason: "PREV_STATE_MALFORMED" };
  }
  if (!consistentState(nextState)) {
    return { ok: false, reason: "NEXT_STATE_MALFORMED" };
  }
  if (prevState.tokenId !== nextState.tokenId) {
    return { ok: false, reason: "TOKEN_ID_MISMATCH" };
  }
  if (amountAtoms <= 0n) {
    return { ok: false, reason: "ZERO_AMOUNT" };
  }
  if (amountAtoms % ATOMS_PER_TOKEN !== 0n) {
    return { ok: false, reason: "SUBTOKEN_AMOUNT" };
  }
  if (
    nextState.publicSupplyAtoms !==
    prevState.publicSupplyAtoms + amountAtoms
  ) {
    return { ok: false, reason: "SUPPLY_CONSERVATION" };
  }
  if (nextState.publicSupplyAtoms > PUBLIC_SUPPLY_ATOMS) {
    return { ok: false, reason: "OVERMINT" };
  }
  let canonical;
  try {
    canonical = applyMint(prevState, amountAtoms);
  } catch {
    return { ok: false, reason: "INVALID_TRANSITION" };
  }
  if (curveContributionSats !== canonical.curveContributionSats) {
    return { ok: false, reason: "PAYMENT_MISMATCH" };
  }
  if (nextState.reserveSats !== prevState.reserveSats + curveContributionSats) {
    return { ok: false, reason: "RESERVE_MOVEMENT" };
  }
  if (stateHash(nextState) !== stateHash(canonical.nextState)) {
    return { ok: false, reason: "SUCCESSOR_STATE_MISMATCH" };
  }
  if (!isWellFormedCommitment(recipientCommitment)) {
    return { ok: false, reason: "RECIPIENT_MALFORMED" };
  }
  if (feeSats < 0n || feeSats > MAX_FEE_SATS) {
    return { ok: false, reason: "FEE_OUT_OF_RANGE" };
  }
  if (network === "mainnet") {
    return { ok: false, reason: "MAINNET_NOT_ACTIVATED" };
  }
  return { ok: true };
}
