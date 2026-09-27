import { createHash } from "node:crypto";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";
import {
  deriveStateOutput,
  stateCommitment,
  stateHash,
  stateTweak,
} from "@crclaunch/cove-covenant";
import type { Atoms, Sats } from "@crclaunch/curve";
import { GuardianError, type GuardianNetwork } from "./policy.js";
import {
  analyzeMintTx,
  resolveAllInputs,
  unsignedTransaction,
  validateMintTx,
  type MintIntent,
  type MintTxAnalysis,
} from "./tx.js";
bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);
const ECPair = ECPairFactory(ecc);
function networkByte(n: GuardianNetwork): number {
  switch (n) {
    case "mainnet":
      return 0x00;
    case "signet":
      return 0x01;
    case "regtest":
      return 0x02;
    case "testnet":
      return 0x03;
  }
}
function u64BE(value: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(value, 0);
  return b;
}
export interface MintAuditRecord {
  prevStateHash: string;
  nextStateHash: string;
  amountAtoms: Atoms;
  curveContributionSats: Sats;
  platformFeeSats: Sats;
  minerFeeSats: Sats;
  recipientCommitment: Buffer;
  txId: Buffer;
  network: GuardianNetwork;
}
export function auditDigest(rec: MintAuditRecord): Buffer {
  const h = createHash("sha256");
  h.update("Cove/GuardianAudit/v1", "utf8");
  h.update(Buffer.from([0x00]));
  h.update(Buffer.from(rec.prevStateHash, "hex"));
  h.update(Buffer.from(rec.nextStateHash, "hex"));
  h.update(u64BE(rec.amountAtoms));
  h.update(u64BE(rec.curveContributionSats));
  h.update(u64BE(rec.platformFeeSats));
  h.update(u64BE(rec.minerFeeSats));
  h.update(rec.recipientCommitment);
  h.update(rec.txId);
  h.update(Buffer.from([networkByte(rec.network)]));
  return h.digest();
}
export interface SignedMintResult {
  psbt: bitcoin.Psbt;
  tapKeySig: Buffer;
  sighash: Buffer;
  analysis: MintTxAnalysis;
  auditDigest: Buffer;
  auditSignature: Buffer;
}
export class TaprootGuardianSigner {
  readonly internalKey: Buffer;
  private readonly keyPair: ReturnType<typeof ECPair.fromWIF>;
  private readonly network: GuardianNetwork;
  constructor(wif: string, network: GuardianNetwork = "regtest") {
    this.network = network;
    const net =
      network === "mainnet"
        ? bitcoin.networks.bitcoin
        : bitcoin.networks.regtest;
    this.keyPair = ECPair.fromWIF(wif, net);
    this.internalKey = Buffer.from(this.keyPair.publicKey.subarray(1));
  }
  signMintTx(psbt: bitcoin.Psbt, intent: MintIntent): SignedMintResult {
    const decision = validateMintTx(
      psbt,
      this.internalKey,
      intent,
      this.network,
    );
    if (!decision.ok) {
      throw new GuardianError("POLICY_REJECTED", decision.reason ?? "rejected");
    }
    const analysis = analyzeMintTx(
      psbt,
      this.internalKey,
      intent,
      this.network,
    );
    const stateInputIndex = analysis.stateInputIndex;
    const tweak = stateTweak(this.internalKey, intent.prevState);
    const tweakedKey = this.keyPair.tweak(tweak);
    psbt.updateInput(stateInputIndex, {
      tapInternalKey: this.internalKey,
      tapMerkleRoot: stateCommitment(intent.prevState),
    });
    psbt.signTaprootInput(stateInputIndex, tweakedKey);
    const inputs = resolveAllInputs(psbt);
    const unsigned = unsignedTransaction(psbt);
    const sighash = unsigned.hashForWitnessV1(
      stateInputIndex,
      inputs.map((i) => i.script),
      inputs.map((i) => Number(i.valueSats)),
      bitcoin.Transaction.SIGHASH_DEFAULT,
    );
    const q0 = deriveStateOutput(this.internalKey, intent.prevState).outputKey;
    const tapKeySig = Buffer.from(
      psbt.data.inputs[stateInputIndex]!.tapKeySig!,
    );
    const sigOk = ecc.verifySchnorr(sighash, q0, tapKeySig.subarray(0, 64));
    if (!sigOk) {
      throw new GuardianError(
        "SIGN_FAILED",
        "produced key-path signature failed to verify",
      );
    }
    const rec: MintAuditRecord = {
      prevStateHash: stateHash(intent.prevState),
      nextStateHash: stateHash(analysis.nextState),
      amountAtoms: intent.amountAtoms,
      curveContributionSats: analysis.curveContributionSats,
      platformFeeSats: analysis.platformFeeSats,
      minerFeeSats: analysis.minerFeeSats,
      recipientCommitment: intent.recipientCommitment,
      txId: unsigned.getHash(),
      network: this.network,
    };
    const digest = auditDigest(rec);
    const auditSignature = Buffer.from(this.keyPair.signSchnorr(digest));
    return {
      psbt,
      tapKeySig,
      sighash,
      analysis,
      auditDigest: digest,
      auditSignature,
    };
  }
  verifyAuditSignature(digest: Buffer, signature: Buffer): boolean {
    return ecc.verifySchnorr(digest, this.internalKey, signature);
  }
}
