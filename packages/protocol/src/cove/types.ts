import type { Atoms, Sats } from "@crclaunch/curve";
export type ProtocolOwnerId = string;
export type CoveOperationKind = "DEPLOY" | "MINT" | "TRANSFER";
export interface CoveProtocolOutput {
  index: number;
  scriptPubKeyHex: string;
  amountSats: Sats;
  role: string;
}
export interface CoveTransaction {
  operation: CoveOperationKind;
  txid: string;
  txIndex: number;
  actor: ProtocolOwnerId;
  recipient?: ProtocolOwnerId;
  ticker?: string;
  amountAtoms?: Atoms;
  supplyBeforeAtoms?: Atoms;
  protocolOutputs: CoveProtocolOutput[];
}
export interface CoveToken {
  deploymentId: string;
  ticker: string;
  creator: ProtocolOwnerId;
  confirmedSupplyAtoms: Atoms;
  publicSupplyAtoms: Atoms;
  currentStage: number;
}
export interface CoveBalance {
  availableAtoms: Atoms;
}
export interface CoveState {
  tokens: Map<string, CoveToken>;
  tickerIndex: Map<string, string>;
  balances: Map<ProtocolOwnerId, Map<string, CoveBalance>>;
  reserveSats: Sats;
  platformTreasurySats: Sats;
}
export interface CoveValidationResult {
  valid: boolean;
  reason: string | null;
}
export function createCoveState(): CoveState {
  return {
    tokens: new Map(),
    tickerIndex: new Map(),
    balances: new Map(),
    reserveSats: 0n,
    platformTreasurySats: 0n,
  };
}
