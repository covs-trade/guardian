import type { CoveStateV2, OutPoint } from "@crclaunch/cove-covenant";
import type { VaultRecoveryProfile } from "@crclaunch/cove-vault";
export interface V3TokenMeta {
  tokenId: string;
  ticker: string;
  policyVersion: number;
  tokenNonce: string;
  deployTxid: string;
  deployHeight: bigint;
  deployBlockHash: string;
  creatorScript: string;
}
export interface V3Backing {
  tokenId: string;
  state: CoveStateV2;
  stateHash: string;
  outpoint: OutPoint;
  scriptPubKey: string;
  btcValue: bigint;
  updatedTxid: string;
  updatedHeight: bigint;
  updatedBlockHash: string;
}
export interface V3TokenUtxo {
  txid: string;
  vout: number;
  tokenId: string;
  amountAtoms: bigint;
  scriptPubKey: string;
  createdHeight: bigint;
  createdBlockHash: string;
}
export type V3Operation = "DEPLOY" | "MINT" | "TRANSFER" | "REDEEM";
export interface V3CurveTrade {
  amountAtoms: bigint;
  grossSats: bigint;
  protocolFeeSats: bigint;
  supplyAfterAtoms: bigint;
  backingAfterSats: bigint;
}
export interface V3Event {
  txid: string;
  blockHeight: bigint;
  blockHash: string;
  txIndex: number;
  operation: V3Operation | null;
  valid: boolean;
  reason: string | null;
  tokenId: string | null;
  curve?: V3CurveTrade | null;
}
export interface V3Cursor {
  network: string;
  height: bigint;
  blockHash: string;
  stateRoot: string;
}
export interface V3BlockInput {
  height: bigint;
  hash: string;
  parentHash: string;
  txs: string[];
}
export interface V3IndexerConfig {
  network: "regtest" | "signet" | "testnet" | "mainnet";
  chainIdentity: string;
  guardianXOnly: Buffer;
  recoveryKeyXOnly: Buffer;
  recoveryProfile?: VaultRecoveryProfile;
  feeScript: Buffer;
  genesisHeight: bigint;
  buyFeeBps?: bigint;
  buyFeeFlatSats?: bigint;
  creatorFeeBps?: bigint;
  redeemFeeBps?: bigint;
  redeemFeeFlatSats?: bigint;
}
export interface BlockUndo {
  height: bigint;
  blockHash: string;
  ops: UndoOp[];
}
export type UndoOp =
  | {
      kind: "DEPLOY";
      tokenId: string;
    }
  | {
      kind: "MINT";
      tokenId: string;
      priorBacking: V3Backing;
      createdUtxo: V3TokenUtxo;
    }
  | {
      kind: "REDEEM";
      tokenId: string;
      spendingTxid: string;
      priorBacking: V3Backing;
      spentUtxos: V3TokenUtxo[];
      createdUtxos: V3TokenUtxo[];
    }
  | {
      kind: "TRANSFER";
      spendingTxid: string;
      spentUtxos: V3TokenUtxo[];
      createdUtxos: V3TokenUtxo[];
    }
  | {
      kind: "BURN";
      spendingTxid: string;
      spentUtxos: V3TokenUtxo[];
    };
