import * as bitcoin from "bitcoinjs-lib";
import {
  applyMint,
  stateOutputScript,
  type CoveState,
} from "@crclaunch/cove-covenant";
import { PRIMARY_MINT_FEE_BPS, computePlatformFee } from "@crclaunch/curve";
import type { Atoms, Sats } from "@crclaunch/curve";
import {
  GuardianError,
  MAX_FEE_SATS,
  isWellFormedCommitment,
  validateStateInvariants,
  type GuardianDecision,
  type GuardianNetwork,
} from "./policy.js";
export const RESERVE_ANCHOR_SATS = 10000n;
export const TOKEN_COMMITMENT_SATS = 1000n;
export interface MintIntent {
  prevState: CoveState;
  amountAtoms: Atoms;
  recipientCommitment: Buffer;
  platformFeeScript: Buffer;
}
export interface MintTxAnalysis {
  stateInputIndex: number;
  nextState: CoveState;
  curveContributionSats: Sats;
  platformFeeSats: Sats;
  minerFeeSats: Sats;
  buyerInputSats: Sats;
  buyerChangeSats: Sats;
}
function toSats(v: number | bigint): Sats {
  return BigInt(v);
}
function u64Check(v: Sats, label: string): void {
  if (v < 0n || v > 0xffffffffffffffffn) {
    throw new GuardianError("AMOUNT_OVERFLOW", `${label} out of u64 range`);
  }
}
function inputScriptAndValue(
  psbt: bitcoin.Psbt,
  index: number,
): {
  script: Buffer;
  valueSats: Sats;
} {
  const input = psbt.data.inputs[index];
  if (!input)
    throw new GuardianError("INPUT_MISSING", `input #${index} missing`);
  if (input.witnessUtxo) {
    return {
      script: Buffer.from(input.witnessUtxo.script),
      valueSats: toSats(input.witnessUtxo.value),
    };
  }
  if (input.nonWitnessUtxo) {
    const vout = psbt.txInputs[index]!.index;
    const prevTx = bitcoin.Transaction.fromBuffer(input.nonWitnessUtxo);
    const out = prevTx.outs[vout];
    if (!out)
      throw new GuardianError(
        "INPUT_MISSING",
        `input #${index} prevout missing`,
      );
    return { script: Buffer.from(out.script), valueSats: toSats(out.value) };
  }
  throw new GuardianError(
    "INPUT_MISSING",
    `input #${index} has no prevout data`,
  );
}
export function resolveAllInputs(psbt: bitcoin.Psbt): {
  script: Buffer;
  valueSats: Sats;
}[] {
  const out: {
    script: Buffer;
    valueSats: Sats;
  }[] = [];
  for (let i = 0; i < psbt.inputCount; i++) {
    out.push(inputScriptAndValue(psbt, i));
  }
  return out;
}
export function unsignedTransaction(psbt: bitcoin.Psbt): bitcoin.Transaction {
  const tx = new bitcoin.Transaction();
  tx.version = psbt.version;
  tx.locktime = psbt.locktime;
  for (const input of psbt.txInputs) {
    tx.ins.push({
      hash: Buffer.from(input.hash),
      index: input.index,
      script: Buffer.alloc(0),
      sequence: input.sequence ?? 0xffffffff,
      witness: [],
    });
  }
  for (const output of psbt.txOutputs) {
    tx.outs.push({ script: Buffer.from(output.script), value: output.value });
  }
  return tx;
}
function bitcoinNetworkFor(network: GuardianNetwork): bitcoin.networks.Network {
  switch (network) {
    case "mainnet":
      return bitcoin.networks.bitcoin;
    case "signet":
      return bitcoin.networks.testnet;
    case "regtest":
      return bitcoin.networks.regtest;
    case "testnet":
      return bitcoin.networks.testnet;
  }
}
export function validateMintTx(
  psbt: bitcoin.Psbt,
  internalKey: Buffer,
  intent: MintIntent,
  network: GuardianNetwork = "regtest",
): GuardianDecision {
  const { prevState, amountAtoms, recipientCommitment, platformFeeScript } =
    intent;
  if (network === "mainnet") {
    return { ok: false, reason: "MAINNET_NOT_ACTIVATED" };
  }
  const expectedNet = bitcoinNetworkFor(network);
  const psbtNet = (
    psbt as unknown as {
      opts: {
        network: bitcoin.networks.Network;
      };
    }
  ).opts.network;
  if (
    psbtNet.bech32 !== expectedNet.bech32 ||
    psbtNet.pubKeyHash !== expectedNet.pubKeyHash ||
    psbtNet.scriptHash !== expectedNet.scriptHash
  ) {
    return { ok: false, reason: "WRONG_NETWORK" };
  }
  const inv = validateStateInvariants(prevState, "MINT");
  if (!inv.ok) return inv;
  let canonical;
  try {
    canonical = applyMint(prevState, amountAtoms);
  } catch {
    return { ok: false, reason: "INVALID_TRANSITION" };
  }
  const nextState = canonical.nextState;
  const curveContributionSats = canonical.curveContributionSats;
  const platformFeeSats = computePlatformFee(
    curveContributionSats,
    PRIMARY_MINT_FEE_BPS,
  );
  if (!isWellFormedCommitment(recipientCommitment)) {
    return { ok: false, reason: "RECIPIENT_MALFORMED" };
  }
  if (platformFeeSats > 0n && !isWellFormedCommitment(platformFeeScript)) {
    return { ok: false, reason: "PLATFORM_FEE_MALFORMED" };
  }
  const stateScript = stateOutputScript(prevState, internalKey, expectedNet);
  const stateIndices: number[] = [];
  const resolved: {
    script: Buffer;
    valueSats: Sats;
  }[] = [];
  for (let i = 0; i < psbt.inputCount; i++) {
    const r = inputScriptAndValue(psbt, i);
    resolved.push(r);
    if (r.script.equals(stateScript)) stateIndices.push(i);
  }
  if (stateIndices.length === 0) {
    return { ok: false, reason: "STATE_INPUT_NOT_FOUND" };
  }
  if (stateIndices.length > 1) {
    return { ok: false, reason: "MULTIPLE_STATE_INPUTS" };
  }
  const stateInputIndex = stateIndices[0]!;
  const expectedPrevValue = prevState.reserveSats + RESERVE_ANCHOR_SATS;
  const prevValue = resolved[stateInputIndex]!.valueSats;
  if (prevValue !== expectedPrevValue) {
    return { ok: false, reason: "STATE_INPUT_WRONG_VALUE" };
  }
  const buyerInputSats = resolved.reduce<Sats>(
    (sum, r, i) => (i === stateInputIndex ? sum : sum + r.valueSats),
    0n,
  );
  if (buyerInputSats <= 0n) {
    return { ok: false, reason: "NO_BUYER_INPUT" };
  }
  const outs = psbt.txOutputs;
  if (outs.length < 2) {
    return { ok: false, reason: "OUTPUT_LAYOUT_INCOMPLETE" };
  }
  const successorScript = stateOutputScript(
    nextState,
    internalKey,
    expectedNet,
  );
  if (!outs[0]!.script.equals(successorScript)) {
    return { ok: false, reason: "SUCCESSOR_SCRIPT_MISMATCH" };
  }
  const expectedSuccessorValue = prevValue + curveContributionSats;
  const successorValue = toSats(outs[0]!.value);
  if (successorValue !== expectedSuccessorValue) {
    return { ok: false, reason: "RESERVE_CONTRIBUTION_MISMATCH" };
  }
  const recipientValue = toSats(outs[1]!.value);
  if (
    !outs[1]!.script.equals(recipientCommitment) ||
    recipientValue !== TOKEN_COMMITMENT_SATS
  ) {
    return { ok: false, reason: "RECIPIENT_OUTPUT_MISMATCH" };
  }
  let cursor = 2;
  let platValue = 0n;
  if (platformFeeSats > 0n) {
    const out = outs[cursor];
    if (!out) return { ok: false, reason: "OUTPUT_LAYOUT_INCOMPLETE" };
    if (
      !out.script.equals(platformFeeScript) ||
      toSats(out.value) !== platformFeeSats
    ) {
      return { ok: false, reason: "PLATFORM_FEE_MISMATCH" };
    }
    platValue = platformFeeSats;
    cursor++;
  }
  const changeOut = outs[cursor];
  let changeValue = 0n;
  if (changeOut) {
    changeValue = toSats(changeOut.value);
    cursor++;
  }
  if (cursor !== outs.length) {
    return { ok: false, reason: "EXTRA_UNAUTHORIZED_OUTPUT" };
  }
  const totalIn = prevValue + buyerInputSats;
  const totalOut = successorValue + recipientValue + platValue + changeValue;
  const minerFeeSats = totalIn - totalOut;
  if (minerFeeSats < 0n || minerFeeSats > MAX_FEE_SATS) {
    return { ok: false, reason: "FEE_OUT_OF_RANGE" };
  }
  const expectedChange =
    buyerInputSats -
    curveContributionSats -
    TOKEN_COMMITMENT_SATS -
    platValue -
    minerFeeSats;
  if (changeValue !== expectedChange) {
    return { ok: false, reason: "CURVE_PAYMENT_MISMATCH" };
  }
  u64Check(minerFeeSats, "minerFeeSats");
  u64Check(totalIn, "totalIn");
  u64Check(totalOut, "totalOut");
  return { ok: true };
}
export function computeMintAnalysis(
  psbt: bitcoin.Psbt,
  internalKey: Buffer,
  intent: MintIntent,
  network: GuardianNetwork = "regtest",
): MintTxAnalysis {
  const { prevState, amountAtoms } = intent;
  const canonical = applyMint(prevState, amountAtoms);
  const curveContributionSats = canonical.curveContributionSats;
  const platformFeeSats = computePlatformFee(
    curveContributionSats,
    PRIMARY_MINT_FEE_BPS,
  );
  const stateScript = stateOutputScript(
    prevState,
    internalKey,
    bitcoinNetworkFor(network),
  );
  let stateInputIndex = -1;
  let prevValue = 0n;
  let buyerInputSats = 0n;
  const resolved: {
    script: Buffer;
    valueSats: Sats;
  }[] = [];
  for (let i = 0; i < psbt.inputCount; i++) {
    const r = inputScriptAndValue(psbt, i);
    resolved.push(r);
    if (r.script.equals(stateScript)) {
      stateInputIndex = i;
      prevValue = r.valueSats;
    }
  }
  buyerInputSats = resolved.reduce<Sats>(
    (sum, r, i) => (i === stateInputIndex ? sum : sum + r.valueSats),
    0n,
  );
  const outs = psbt.txOutputs;
  const successorValue = toSats(outs[0]!.value);
  const recipientValue = toSats(outs[1]!.value);
  let platValue = 0n;
  let changeValue = 0n;
  let cursor = 2;
  if (platformFeeSats > 0n) {
    platValue = toSats(outs[cursor]!.value);
    cursor++;
  }
  if (outs[cursor]) {
    changeValue = toSats(outs[cursor]!.value);
  }
  const totalIn = prevValue + buyerInputSats;
  const totalOut = successorValue + recipientValue + platValue + changeValue;
  return {
    stateInputIndex,
    nextState: canonical.nextState,
    curveContributionSats,
    platformFeeSats,
    minerFeeSats: totalIn - totalOut,
    buyerInputSats,
    buyerChangeSats: changeValue,
  };
}
export function analyzeMintTx(
  psbt: bitcoin.Psbt,
  internalKey: Buffer,
  intent: MintIntent,
  network: GuardianNetwork = "regtest",
): MintTxAnalysis {
  const decision = validateMintTx(psbt, internalKey, intent, network);
  if (!decision.ok) {
    throw new GuardianError("POLICY_REJECTED", decision.reason ?? "rejected");
  }
  return computeMintAnalysis(psbt, internalKey, intent, network);
}
export interface ResolvedInput {
  txid: string;
  vout: number;
  script: Buffer;
  valueSats: Sats;
}
export interface BuildMintPsbtParams {
  internalKey: Buffer;
  intent: MintIntent;
  stateInput: ResolvedInput;
  buyerInputs: ResolvedInput[];
  buyerChangeScript: Buffer;
  minerFeeSats: Sats;
  network: GuardianNetwork;
}
export function buildMintPsbt(params: BuildMintPsbtParams): {
  psbt: bitcoin.Psbt;
  analysis: MintTxAnalysis;
} {
  const {
    internalKey,
    intent,
    stateInput,
    buyerInputs,
    buyerChangeScript,
    minerFeeSats,
    network,
  } = params;
  const { prevState, amountAtoms, recipientCommitment, platformFeeScript } =
    intent;
  const canonical = applyMint(prevState, amountAtoms);
  const nextState = canonical.nextState;
  const curveContributionSats = canonical.curveContributionSats;
  const platformFeeSats = computePlatformFee(
    curveContributionSats,
    PRIMARY_MINT_FEE_BPS,
  );
  const net = bitcoinNetworkFor(network);
  const psbt = new bitcoin.Psbt({ network: net });
  psbt.addInput({
    hash: stateInput.txid,
    index: stateInput.vout,
    witnessUtxo: {
      script: stateInput.script,
      value: Number(stateInput.valueSats),
    },
  });
  for (const b of buyerInputs) {
    psbt.addInput({
      hash: b.txid,
      index: b.vout,
      witnessUtxo: { script: b.script, value: Number(b.valueSats) },
    });
  }
  const successorValue = stateInput.valueSats + curveContributionSats;
  psbt.addOutput({
    script: stateOutputScript(nextState, internalKey, net),
    value: Number(successorValue),
  });
  psbt.addOutput({
    script: recipientCommitment,
    value: Number(TOKEN_COMMITMENT_SATS),
  });
  if (platformFeeSats > 0n) {
    psbt.addOutput({
      script: platformFeeScript,
      value: Number(platformFeeSats),
    });
  }
  const totalBuyerIn = buyerInputs.reduce<Sats>((s, b) => s + b.valueSats, 0n);
  const changeValue =
    totalBuyerIn -
    curveContributionSats -
    TOKEN_COMMITMENT_SATS -
    platformFeeSats -
    minerFeeSats;
  if (changeValue < 0n) {
    throw new GuardianError(
      "INSUFFICIENT_FUNDS",
      "buyer inputs do not cover the mint",
    );
  }
  if (changeValue > 0n) {
    psbt.addOutput({ script: buyerChangeScript, value: Number(changeValue) });
  }
  const analysis = computeMintAnalysis(psbt, internalKey, intent, network);
  return { psbt, analysis };
}
