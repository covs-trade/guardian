import * as bitcoin from "bitcoinjs-lib";
import { randomUUID } from "node:crypto";
import { stateHashV2 } from "@crclaunch/cove-covenant";
import {
  buildBackingVaultV3,
  type VaultRecoveryProfile,
} from "@crclaunch/cove-vault";
import { COVE_POLICY_V3 } from "@crclaunch/cove-wire";
import { unsignedTxDigest } from "./resolve.js";
import type { GuardianV3Signer } from "./signer.js";
import {
  validateMintTransitionV3,
  validateRedeemTransitionV3,
} from "./validate.js";
import { type AuditSink } from "./audit.js";
import type { FundingInputChecker } from "./funding.js";
import {
  type AuditRecord,
  type CoveCanonicalView,
  type GuardianV3Network,
  type MintAnalysis,
  type RedeemAnalysis,
  type SignedTransitionResult,
  type ValidationFailureCode,
} from "./types.js";
export interface SignTransitionParams {
  signer: GuardianV3Signer;
  psbt: bitcoin.Psbt;
  view: CoveCanonicalView;
  network: GuardianV3Network;
  recoveryKeyXOnly: Buffer;
  recoveryProfile?: VaultRecoveryProfile;
  feeScript: Buffer;
  maxMinerFeeSats?: bigint;
  buyFeeBps?: bigint;
  redeemFeeBps?: bigint;
  auditSink?: AuditSink;
  fundingChecker: FundingInputChecker;
}
export type SignTransitionOutcome =
  | SignedTransitionResult
  | {
      ok: false;
      reason: ValidationFailureCode;
      detail: string;
      audit: AuditRecord;
    };
function bitcoinNetwork(network: GuardianV3Network): bitcoin.networks.Network {
  switch (network) {
    case "regtest":
      return bitcoin.networks.regtest;
    case "mainnet":
      return bitcoin.networks.bitcoin;
    case "testnet":
    case "signet":
      return bitcoin.networks.testnet;
    default:
      throw new Error(`bad network ${String(network)}`);
  }
}
function buildAudit(params: {
  operation: "MINT" | "REDEEM";
  network: GuardianV3Network;
  psbt: bitcoin.Psbt;
  decision: "VALID_TO_SIGN" | "REJECTED";
  rejectionReason: string | null;
  analysis: MintAnalysis | RedeemAnalysis | null;
  expectedCmr: string | null;
  actualCmr: string | null;
  simplicityResult: "PASS" | "FAIL";
  referencePolicyResult: "PASS" | "FAIL";
}): AuditRecord {
  const a = params.analysis;
  return {
    requestId: randomUUID(),
    operation: params.operation,
    tokenId: a ? a.tokenId.toString("hex") : "",
    prevStateHash: a ? stateHashV2(a.currentState) : "",
    nextStateHash: a ? stateHashV2(a.nextState) : "",
    backingOutpoint: a ? a.backingOutpoint : { txid: "", vout: -1 },
    tokenInputOutpoints: a && a.op === "REDEEM" ? a.tokenInputOutpoints : [],
    amountAtoms:
      a && a.op === "MINT"
        ? a.amountAtoms
        : a && a.op === "REDEEM"
          ? a.redeemAmountAtoms
          : 0n,
    grossSats: a ? a.grossSats : 0n,
    protocolFeeSats: a ? a.protocolFeeSats : 0n,
    minerFeeSats: a ? a.minerFeeSats : 0n,
    policyVersion: COVE_POLICY_V3,
    expectedCmr: params.expectedCmr ?? "",
    actualCmr: params.actualCmr ?? "",
    simplicityResult: params.simplicityResult,
    referencePolicyResult: params.referencePolicyResult,
    unsignedTxDigest: unsignedTxDigest(params.psbt),
    network: params.network,
    decision: params.decision,
    rejectionReason: params.rejectionReason,
    timestamp: new Date().toISOString(),
  };
}
export async function validateAndSignMintTransition(
  params: SignTransitionParams,
): Promise<SignTransitionOutcome> {
  const guardianXOnly = params.signer.xOnlyPubkey();
  const v = await validateMintTransitionV3({
    psbt: params.psbt,
    view: params.view,
    network: params.network,
    guardianXOnly,
    recoveryKeyXOnly: params.recoveryKeyXOnly,
    recoveryProfile: params.recoveryProfile,
    feeScript: params.feeScript,
    maxMinerFeeSats: params.maxMinerFeeSats,
    buyFeeBps: params.buyFeeBps,
    redeemFeeBps: params.redeemFeeBps,
    fundingChecker: params.fundingChecker,
  });
  const analysis = v.ok ? (v.analysis as MintAnalysis) : null;
  const audit = buildAudit({
    operation: "MINT",
    network: params.network,
    psbt: params.psbt,
    decision: v.ok ? "VALID_TO_SIGN" : "REJECTED",
    rejectionReason: v.ok ? null : `${v.reason}: ${v.detail}`,
    analysis,
    expectedCmr: v.ok ? v.simplicity.expectedCmr : null,
    actualCmr: v.ok ? v.simplicity.actualCmr : null,
    simplicityResult: v.ok ? v.simplicity.result : "FAIL",
    referencePolicyResult: v.ok ? "PASS" : "FAIL",
  });
  params.auditSink?.write(audit);
  if (!v.ok) {
    return { ok: false, reason: v.reason, detail: v.detail, audit };
  }
  const a = v.analysis;
  const prevVault = buildBackingVaultV3({
    state: a.currentState,
    guardianXOnly,
    recoveryKeyXOnly: params.recoveryKeyXOnly,
    recoveryProfile: params.recoveryProfile,
    network: bitcoinNetwork(params.network),
  });
  params.signer.signVaultExecutionLeaf(
    params.psbt,
    0,
    prevVault.mintLeaf,
    prevVault.mintControlBlock,
  );
  return {
    ok: true,
    operation: "MINT",
    tokenId: a.tokenId.toString("hex"),
    prevStateHash: stateHashV2(a.currentState),
    nextStateHash: stateHashV2(a.nextState),
    expectedCmr: v.simplicity.expectedCmr,
    actualCmr: v.simplicity.actualCmr!,
    simplicityResult: v.simplicity.result,
    referencePolicyResult: "PASS",
    backingOutpoint: a.backingOutpoint,
    signedInputIndex: 0,
    audit,
    auditFinalizationError: null,
  };
}
export async function validateAndSignRedeemTransition(
  params: SignTransitionParams,
): Promise<SignTransitionOutcome> {
  const guardianXOnly = params.signer.xOnlyPubkey();
  const v = await validateRedeemTransitionV3({
    psbt: params.psbt,
    view: params.view,
    network: params.network,
    guardianXOnly,
    recoveryKeyXOnly: params.recoveryKeyXOnly,
    recoveryProfile: params.recoveryProfile,
    feeScript: params.feeScript,
    maxMinerFeeSats: params.maxMinerFeeSats,
    buyFeeBps: params.buyFeeBps,
    redeemFeeBps: params.redeemFeeBps,
    fundingChecker: params.fundingChecker,
  });
  const analysis = v.ok ? (v.analysis as RedeemAnalysis) : null;
  const audit = buildAudit({
    operation: "REDEEM",
    network: params.network,
    psbt: params.psbt,
    decision: v.ok ? "VALID_TO_SIGN" : "REJECTED",
    rejectionReason: v.ok ? null : `${v.reason}: ${v.detail}`,
    analysis,
    expectedCmr: v.ok ? v.simplicity.expectedCmr : null,
    actualCmr: v.ok ? v.simplicity.actualCmr : null,
    simplicityResult: v.ok ? v.simplicity.result : "FAIL",
    referencePolicyResult: v.ok ? "PASS" : "FAIL",
  });
  params.auditSink?.write(audit);
  if (!v.ok) {
    return { ok: false, reason: v.reason, detail: v.detail, audit };
  }
  const a = v.analysis;
  const prevVault = buildBackingVaultV3({
    state: a.currentState,
    guardianXOnly,
    recoveryKeyXOnly: params.recoveryKeyXOnly,
    recoveryProfile: params.recoveryProfile,
    network: bitcoinNetwork(params.network),
  });
  params.signer.signVaultExecutionLeaf(
    params.psbt,
    0,
    prevVault.redeemLeaf,
    prevVault.redeemControlBlock,
  );
  return {
    ok: true,
    operation: "REDEEM",
    tokenId: a.tokenId.toString("hex"),
    prevStateHash: stateHashV2(a.currentState),
    nextStateHash: stateHashV2(a.nextState),
    expectedCmr: v.simplicity.expectedCmr,
    actualCmr: v.simplicity.actualCmr!,
    simplicityResult: v.simplicity.result,
    referencePolicyResult: "PASS",
    backingOutpoint: a.backingOutpoint,
    signedInputIndex: 0,
    audit,
    auditFinalizationError: null,
  };
}
