import * as bitcoin from "bitcoinjs-lib";
import { randomUUID } from "node:crypto";
import { stateHashV2, type CoveCanonicalView } from "@crclaunch/cove-covenant";
import {
  buildBackingVaultV3,
  tapleafHash,
  type VaultRecoveryProfile,
} from "@crclaunch/cove-vault";
import { COVE_POLICY_V3 } from "@crclaunch/cove-wire";
import {
  validateMintTransitionV3,
  validateRedeemTransitionV3,
} from "./validate.js";
import { unsignedTxDigest, decodeCoveOpReturn } from "./resolve.js";
import { verifyVaultExecutionSignature } from "./signer.js";
import type { GuardianSigningBackend } from "./custody.js";
import type { FundingInputChecker } from "./funding.js";
import type { SigningJournalStore } from "./journal.js";
import type {
  GuardianTransport,
  GuardianSignRequestWire,
} from "./guardianApi.js";
import {
  parseBigint,
  stringifyBigint,
  extractWitnessSig,
} from "./guardianApi.js";
import type {
  AuditRecord,
  GuardianV3Network,
  MintAnalysis,
  RedeemAnalysis,
  SignedTransitionResult,
} from "./types.js";
export interface DurableAuditSink {
  writeBeforeSign(record: AuditRecord): Promise<{
    auditHash: string;
  }>;
  writeAfterSign(record: AuditRecord, auditHash: string): Promise<void>;
}
export interface TransitionSignRequest {
  psbt: bitcoin.Psbt;
  view: CoveCanonicalView;
  network: GuardianV3Network;
  recoveryKeyXOnly: Buffer;
  recoveryProfile?: VaultRecoveryProfile;
  feeScript: Buffer;
  maxMinerFeeSats?: bigint;
  buyFeeBps?: bigint;
  redeemFeeBps?: bigint;
  buyFeeFlatSats?: bigint;
  creatorFeeBps?: bigint;
  redeemFeeFlatSats?: bigint;
  discoveryTicker?: string;
  fundingChecker: FundingInputChecker;
}
export type TransitionSignOutcome =
  | SignedTransitionResult
  | {
      ok: false;
      reason: string;
      detail: string;
      audit: AuditRecord | null;
    };
export interface GuardianRiskPolicy {
  maxGrossSats: bigint;
  maxMintAtoms: bigint;
  minMintGrossSats: bigint;
  maxRedeemPayoutSats: bigint;
  maxBackingSats: bigint;
  maxMinerFeeSats: bigint;
  allowedTokenIds: string[];
  enforceTokenAllowlist: boolean;
}
export function checkRiskPolicy(
  policy: GuardianRiskPolicy,
  analysis: MintAnalysis | RedeemAnalysis,
  operation: "MINT" | "REDEEM",
): string | null {
  const tokenId = analysis.tokenId.toString("hex");
  if (
    policy.enforceTokenAllowlist &&
    !policy.allowedTokenIds.includes(tokenId)
  ) {
    return `token ${tokenId} is not in the canary allowlist`;
  }
  if (analysis.grossSats > policy.maxGrossSats)
    return `gross ${analysis.grossSats} exceeds cap ${policy.maxGrossSats}`;
  if (operation === "MINT") {
    const amount = (analysis as MintAnalysis).amountAtoms;
    if (amount > policy.maxMintAtoms) {
      return `mint of ${amount / 100000000n} tokens exceeds the per-mint limit of ${policy.maxMintAtoms / 100000000n}`;
    }
    if (analysis.grossSats < policy.minMintGrossSats) {
      return `mint of ${analysis.grossSats} sats is below the minimum of ${policy.minMintGrossSats}`;
    }
  }
  if (analysis.nextState.backingSats > policy.maxBackingSats)
    return `next backing ${analysis.nextState.backingSats} exceeds cap ${policy.maxBackingSats}`;
  if (analysis.minerFeeSats > policy.maxMinerFeeSats)
    return `miner fee ${analysis.minerFeeSats} exceeds cap ${policy.maxMinerFeeSats}`;
  if (
    operation === "REDEEM" &&
    (analysis as RedeemAnalysis).netPayoutSats > policy.maxRedeemPayoutSats
  ) {
    return `redeem payout exceeds cap ${policy.maxRedeemPayoutSats}`;
  }
  return null;
}
export interface GuardianTransitionSigner {
  signMint(req: TransitionSignRequest): Promise<TransitionSignOutcome>;
  signRedeem(req: TransitionSignRequest): Promise<TransitionSignOutcome>;
  health(): Promise<{
    reachable: boolean;
    reason?: string;
  }>;
}
function buildAuditRecord(params: {
  operation: "MINT" | "REDEEM";
  network: GuardianV3Network;
  psbt: bitcoin.Psbt;
  analysis: MintAnalysis | RedeemAnalysis;
  expectedCmr: string | null;
  actualCmr: string | null;
  simplicityResult: "PASS" | "FAIL";
  decision: "VALID_TO_SIGN" | "REJECTED";
  rejectionReason: string | null;
}): AuditRecord {
  const a = params.analysis;
  const tokenId = a.tokenId.toString("hex");
  const prev = "prevStateHash" in a ? a.currentState : a.currentState;
  return {
    requestId: randomUUID(),
    operation: params.operation,
    tokenId,
    prevStateHash: stateHashV2(prev),
    nextStateHash: stateHashV2(a.nextState),
    backingOutpoint: a.backingOutpoint,
    tokenInputOutpoints:
      params.operation === "REDEEM"
        ? (a as RedeemAnalysis).tokenInputOutpoints
        : [],
    amountAtoms:
      params.operation === "MINT"
        ? (a as MintAnalysis).amountAtoms
        : (a as RedeemAnalysis).redeemAmountAtoms,
    grossSats: a.grossSats,
    protocolFeeSats: a.protocolFeeSats,
    minerFeeSats: a.minerFeeSats,
    policyVersion: COVE_POLICY_V3,
    expectedCmr: params.expectedCmr ?? "",
    actualCmr: params.actualCmr ?? "",
    simplicityResult: params.simplicityResult,
    referencePolicyResult: "PASS",
    unsignedTxDigest: unsignedTxDigest(params.psbt),
    network: params.network,
    decision: params.decision,
    rejectionReason: params.rejectionReason,
    timestamp: new Date().toISOString(),
  };
}
export class LocalGuardianTransitionSigner implements GuardianTransitionSigner {
  constructor(
    private readonly signer: GuardianSigningBackend,
    private readonly journal: SigningJournalStore,
    private readonly audit: DurableAuditSink,
    private readonly riskPolicy: GuardianRiskPolicy,
  ) {}
  async signMint(req: TransitionSignRequest): Promise<TransitionSignOutcome> {
    return this.sign(req, "MINT");
  }
  async signRedeem(req: TransitionSignRequest): Promise<TransitionSignOutcome> {
    return this.sign(req, "REDEEM");
  }
  async health(): Promise<{
    reachable: boolean;
  }> {
    return { reachable: true };
  }
  private async sign(
    req: TransitionSignRequest,
    op: "MINT" | "REDEEM",
  ): Promise<TransitionSignOutcome> {
    const guardianXOnly = await this.signer.xOnlyPubkey();
    const cached = await this.recoverSigned(req, op);
    if (cached) return cached;
    const validate = await (op === "MINT"
      ? validateMintTransitionV3({ ...req, guardianXOnly })
      : validateRedeemTransitionV3({ ...req, guardianXOnly }));
    if (!validate.ok) {
      return {
        ok: false,
        reason: validate.reason,
        detail: validate.detail,
        audit: null,
      };
    }
    const analysis = validate.analysis;
    const risk = checkRiskPolicy(this.riskPolicy, analysis, op);
    if (risk) {
      return {
        ok: false,
        reason: "RISK_POLICY_REJECTED",
        detail: risk,
        audit: null,
      };
    }
    const record = buildAuditRecord({
      operation: op,
      network: req.network,
      psbt: req.psbt,
      analysis,
      expectedCmr: validate.simplicity.expectedCmr,
      actualCmr: validate.simplicity.actualCmr,
      simplicityResult: validate.simplicity.result,
      decision: "VALID_TO_SIGN",
      rejectionReason: null,
    });
    let receipt: {
      auditHash: string;
    };
    try {
      receipt = await this.audit.writeBeforeSign(record);
    } catch (e) {
      return {
        ok: false,
        reason: "AUDIT_PERSISTENCE_FAILED",
        detail: (e as Error).message,
        audit: record,
      };
    }
    const reservation = await this.journal.reserve({
      network: req.network,
      backingTxid: record.backingOutpoint.txid,
      backingVout: record.backingOutpoint.vout,
      unsignedTxDigest: record.unsignedTxDigest,
    });
    if (reservation === "CONFLICT") {
      return {
        ok: false,
        reason: "BACKING_ALREADY_SIGNED",
        detail: "backing outpoint already signed with a different digest",
        audit: record,
      };
    }
    const prevVault = buildBackingVaultV3({
      state: analysis.currentState,
      guardianXOnly,
      recoveryKeyXOnly: req.recoveryKeyXOnly,
      recoveryProfile: req.recoveryProfile,
      network:
        req.network === "regtest"
          ? bitcoin.networks.regtest
          : req.network === "mainnet"
            ? bitcoin.networks.bitcoin
            : bitcoin.networks.testnet,
    });
    const leaf = op === "MINT" ? prevVault.mintLeaf : prevVault.redeemLeaf;
    const control =
      op === "MINT" ? prevVault.mintControlBlock : prevVault.redeemControlBlock;
    let signatureProduced = false;
    try {
      await this.signer.signVaultExecutionLeaf(req.psbt, 0, leaf, control);
      signatureProduced = true;
      await this.journal.markSigned({
        network: req.network,
        backingTxid: record.backingOutpoint.txid,
        backingVout: record.backingOutpoint.vout,
        unsignedTxDigest: record.unsignedTxDigest,
        signingResult: {
          psbtBase64: req.psbt.toBase64(),
          auditHash: receipt.auditHash,
          resultJson: stringifyBigint(this.signedOutcome(record)),
        },
      });
      const stored = await this.journal.readSigned?.({
        network: req.network,
        backingTxid: record.backingOutpoint.txid,
        backingVout: record.backingOutpoint.vout,
        unsignedTxDigest: record.unsignedTxDigest,
      });
      if (stored)
        return this.restoreSigningResult(req, op, guardianXOnly, stored);
    } catch (e) {
      if (!signatureProduced && reservation === "RESERVED") {
        await this.journal.release({
          network: req.network,
          backingTxid: record.backingOutpoint.txid,
          backingVout: record.backingOutpoint.vout,
          unsignedTxDigest: record.unsignedTxDigest,
        });
      }
      return {
        ok: false,
        reason: "SIGNING_FAILED",
        detail: (e as Error).message,
        audit: record,
      };
    }
    let auditFinalizationError: string | null = null;
    try {
      await this.audit.writeAfterSign(record, receipt.auditHash);
    } catch (e) {
      auditFinalizationError = (e as Error).message;
      console.error(
        `SIGNED_BUT_AUDIT_FINALIZATION_FAILED: ${op} ${record.backingOutpoint.txid}:${record.backingOutpoint.vout} — ${auditFinalizationError}`,
      );
    }
    return {
      ok: true,
      operation: op,
      tokenId: record.tokenId,
      prevStateHash: record.prevStateHash,
      nextStateHash: record.nextStateHash,
      expectedCmr: record.expectedCmr,
      actualCmr: record.actualCmr,
      simplicityResult: record.simplicityResult,
      referencePolicyResult: "PASS",
      backingOutpoint: record.backingOutpoint,
      signedInputIndex: 0,
      audit: record,
      auditFinalizationError,
    };
  }
  async recoverSigned(
    req: Pick<TransitionSignRequest, "psbt" | "network">,
    op: "MINT" | "REDEEM",
  ): Promise<TransitionSignOutcome | null> {
    const input = req.psbt.txInputs[0];
    if (!input || !this.journal.readSigned) return null;
    const cached = await this.journal.readSigned({
      network: req.network,
      backingTxid: Buffer.from(input.hash).reverse().toString("hex"),
      backingVout: input.index,
      unsignedTxDigest: unsignedTxDigest(req.psbt),
    });
    return cached
      ? this.restoreSigningResult(
          req,
          op,
          await this.signer.xOnlyPubkey(),
          cached,
        )
      : null;
  }
  private signedOutcome(record: AuditRecord): SignedTransitionResult {
    return {
      ok: true,
      operation: record.operation,
      tokenId: record.tokenId,
      prevStateHash: record.prevStateHash,
      nextStateHash: record.nextStateHash,
      expectedCmr: record.expectedCmr,
      actualCmr: record.actualCmr,
      simplicityResult: record.simplicityResult,
      referencePolicyResult: "PASS",
      backingOutpoint: record.backingOutpoint,
      signedInputIndex: 0,
      audit: record,
      auditFinalizationError: null,
    };
  }
  private async restoreSigningResult(
    req: Pick<TransitionSignRequest, "psbt" | "network">,
    op: "MINT" | "REDEEM",
    guardianXOnly: Buffer,
    cached: {
      psbtBase64: string;
      resultJson: string;
      auditHash: string;
    },
  ): Promise<TransitionSignOutcome> {
    const outcome = parseBigint<SignedTransitionResult>(cached.resultJson);
    const signed = bitcoin.Psbt.fromBase64(cached.psbtBase64);
    const witness = signed.data.inputs[0]?.finalScriptWitness;
    const leaf = req.psbt.data.inputs[0]?.tapLeafScript?.[0];
    if (
      outcome.operation !== op ||
      unsignedTxDigest(signed) !== unsignedTxDigest(req.psbt) ||
      !witness ||
      !leaf
    ) {
      return {
        ok: false,
        reason: "SIGNATURE_VERIFICATION_FAILED",
        detail: "saved signing commitment mismatch",
        audit: null,
      };
    }
    try {
      verifyVaultExecutionSignature(
        req.psbt,
        0,
        {
          script: leaf.script,
          tapleafHash: tapleafHash(leaf.script, leaf.leafVersion),
        },
        extractWitnessSig(witness),
        guardianXOnly,
      );
      if (req.psbt.data.inputs[0]!.finalScriptWitness)
        req.psbt.data.inputs[0]!.finalScriptWitness = Buffer.from(witness);
      else req.psbt.updateInput(0, { finalScriptWitness: witness });
    } catch {
      return {
        ok: false,
        reason: "SIGNATURE_VERIFICATION_FAILED",
        detail: "saved signature could not be verified",
        audit: null,
      };
    }
    try {
      await this.audit.writeAfterSign(outcome.audit, cached.auditHash);
    } catch (error) {
      outcome.auditFinalizationError =
        error instanceof Error
          ? error.message
          : "audit finalization unavailable";
      console.error(
        "SIGNED_BUT_AUDIT_FINALIZATION_FAILED:",
        op,
        outcome.backingOutpoint.txid,
      );
    }
    return outcome;
  }
}
export class RemoteGuardianTransitionSigner implements GuardianTransitionSigner {
  constructor(
    private readonly transport: GuardianTransport,
    private readonly expectedProfileHash: string,
    private readonly expectedGuardianXOnly: string,
    private readonly timeoutMs = 10000,
  ) {}
  async signMint(req: TransitionSignRequest): Promise<TransitionSignOutcome> {
    return this.sign(req, "MINT");
  }
  async signRedeem(req: TransitionSignRequest): Promise<TransitionSignOutcome> {
    return this.sign(req, "REDEEM");
  }
  async health(): Promise<{
    reachable: boolean;
    reason?: string;
  }> {
    try {
      const h = await this.transport.health();
      if (!h.reachable)
        return { reachable: false, reason: "guardian unreachable" };
      if (h.profileHash !== this.expectedProfileHash)
        return {
          reachable: false,
          reason: `GUARDIAN_PROFILE_MISMATCH: ${h.profileHash.slice(0, 8)}…`,
        };
      if (
        h.guardianXOnly.toLowerCase() !==
        this.expectedGuardianXOnly.toLowerCase()
      )
        return { reachable: false, reason: "GUARDIAN_KEY_MISMATCH" };
      return { reachable: true };
    } catch (e) {
      return { reachable: false, reason: (e as Error).message };
    }
  }
  private async sign(
    req: TransitionSignRequest,
    op: "MINT" | "REDEEM",
  ): Promise<TransitionSignOutcome> {
    const envelope = decodeCoveOpReturn(req.psbt);
    if (!("tokenId" in envelope)) {
      return {
        ok: false,
        reason: "BAD_PSBT",
        detail: "PSBT envelope is not a MINT/REDEEM",
        audit: null,
      };
    }
    const tokenId = Buffer.from(envelope.tokenId).toString("hex");
    const wire: GuardianSignRequestWire = {
      requestId: randomUUID(),
      operation: op,
      network: req.network,
      psbtBase64: req.psbt.toBase64(),
      tokenId,
    };
    let response;
    try {
      response = await this.withTimeout(
        this.transport.sign(wire),
        this.timeoutMs,
      );
    } catch (e) {
      const code =
        (e as Error).name === "TimeoutError" ||
        (e as Error).message.includes("timeout")
          ? "GUARDIAN_TIMEOUT"
          : "REMOTE_GUARDIAN_UNAVAILABLE";
      return {
        ok: false,
        reason: code,
        detail: (e as Error).message,
        audit: null,
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        reason: response.reason,
        detail: response.detail,
        audit: null,
      };
    }
    if (response.profileHash !== this.expectedProfileHash) {
      return {
        ok: false,
        reason: "GUARDIAN_PROFILE_MISMATCH",
        detail: "service profile hash differs from the committed profile",
        audit: null,
      };
    }
    if (
      response.guardianXOnly.toLowerCase() !==
      this.expectedGuardianXOnly.toLowerCase()
    ) {
      return {
        ok: false,
        reason: "GUARDIAN_KEY_MISMATCH",
        detail: "service Guardian key differs from the committed profile",
        audit: null,
      };
    }
    const sig = Buffer.from(response.sigHex, "hex");
    try {
      this.independentlyVerifySignature(req.psbt, sig);
    } catch (e) {
      return {
        ok: false,
        reason: "SIGNATURE_VERIFICATION_FAILED",
        detail: (e as Error).message,
        audit: null,
      };
    }
    const signedPsbt = bitcoin.Psbt.fromBase64(response.signedPsbtBase64);
    const witness = signedPsbt.data.inputs[0]!.finalScriptWitness;
    if (!witness)
      return {
        ok: false,
        reason: "SIGNATURE_VERIFICATION_FAILED",
        detail: "service returned no final witness",
        audit: null,
      };
    req.psbt.updateInput(0, { finalScriptWitness: witness });
    return parseBigint<SignedTransitionResult>(response.resultJson);
  }
  private independentlyVerifySignature(psbt: bitcoin.Psbt, sig: Buffer): void {
    const tapLeaf = psbt.data.inputs[0]!.tapLeafScript?.[0];
    if (!tapLeaf)
      throw new Error(
        "SIGNATURE_VERIFICATION_FAILED: no tap leaf script on input 0",
      );
    const leaf = {
      script: tapLeaf.script,
      tapleafHash: tapleafHash(tapLeaf.script, tapLeaf.leafVersion),
    };
    verifyVaultExecutionSignature(
      psbt,
      0,
      leaf,
      sig,
      Buffer.from(this.expectedGuardianXOnly, "hex"),
    );
  }
  private async withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("guardian request timeout")),
        ms,
      );
    });
    try {
      return await Promise.race([p, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
