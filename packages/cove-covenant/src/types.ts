import type { Atoms, Sats } from "@crclaunch/curve";
export type CovePhase = "PUBLIC_MINT" | "GRADUATED" | "LIQUIDITY";
export const PHASE_PUBLIC_MINT = 0x00;
export const PHASE_GRADUATED = 0x01;
export const PHASE_LIQUIDITY = 0x02;
export interface CoveState {
  version: number;
  tokenId: string;
  phase: CovePhase;
  publicSupplyAtoms: Atoms;
  reserveSats: Sats;
  curveStage: number;
}
export type CoveOperation = "MINT" | "GRADUATE" | "BUY" | "SELL" | "TRANSFER";
export interface CoveTransition {
  operation: CoveOperation;
  prevState: CoveState;
  nextState: CoveState;
}
export function phaseToByte(phase: CovePhase): number {
  switch (phase) {
    case "PUBLIC_MINT":
      return PHASE_PUBLIC_MINT;
    case "GRADUATED":
      return PHASE_GRADUATED;
    case "LIQUIDITY":
      return PHASE_LIQUIDITY;
  }
}
export function byteToPhase(b: number): CovePhase {
  switch (b) {
    case PHASE_PUBLIC_MINT:
      return "PUBLIC_MINT";
    case PHASE_GRADUATED:
      return "GRADUATED";
    case PHASE_LIQUIDITY:
      return "LIQUIDITY";
    default:
      throw new Error(`Unknown Cove phase byte ${b}`);
  }
}
