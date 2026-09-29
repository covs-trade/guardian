import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { psbtInputFor } from "@crclaunch/bitcoin";
import {
  TOKEN_CARRIER_SATS,
  applyMintV2,
  applyRedeemV2,
  s0StateV2,
  type CoveStateV2,
} from "@crclaunch/cove-covenant";
import {
  buildBackingVaultV3,
  type CoveVaultV3,
  type VaultRecoveryProfile,
} from "@crclaunch/cove-vault";
import {
  COVE_POLICY_V3,
  computeTokenId,
  encodeDeployV2,
  encodeMintV2,
  encodeDiscovery,
  decodeV2,
  encodeRedeemV2,
  encodeTransferV2,
  type TokenIdentityInput,
} from "@crclaunch/cove-wire";
import { grossBuy } from "@crclaunch/cove-economics";
import {
  mintFeeSats,
  redeemFeeSats as redeemFeeOf,
  creatorFeeSats,
  CREATOR_RECORD_SATS,
  LAUNCH_FEE_SATS,
  dustThreshold,
  COVE_FEE_CONFIG,
} from "@crclaunch/cove-economics";
import type { Sats } from "@crclaunch/curve";

bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);

export const RESERVE_ANCHOR_SATS = 10_000n;

function addChangeOrAbsorb(
  psbt: bitcoin.Psbt,
  changeScript: Buffer,
  changeSats: Sats,
  minerFeeSats: Sats,
): { minerFeeSats: Sats; changeSats: Sats; absorbedSats: Sats } {
  if (changeSats <= 0n)
    return { minerFeeSats, changeSats: 0n, absorbedSats: 0n };
  if (changeSats >= dustThreshold(changeScript)) {
    psbt.addOutput({ script: changeScript, value: Number(changeSats) });
    return { minerFeeSats, changeSats, absorbedSats: 0n };
  }
  return {
    minerFeeSats: minerFeeSats + changeSats,
    changeSats: 0n,
    absorbedSats: changeSats,
  };
}

export interface ResolvedInput {
  txid: string;
  vout: number;
  script: Buffer;
  valueSats: Sats;

  publicKey?: Buffer;
}

export interface DeployResult {
  psbt: bitcoin.Psbt;
  tokenId: Buffer;
  s0: CoveStateV2;
  vault: CoveVaultV3;
  wire: Buffer;

  minerFeeSats: Sats;
}

export function buildDeployPsbtV3(params: {
  network: bitcoin.networks.Network;

  identity: Omit<TokenIdentityInput, "creatorScript">;
  guardianXOnly: Buffer;
  recoveryKeyXOnly: Buffer;
  recoveryProfile?: VaultRecoveryProfile;
  deployerInputs: ResolvedInput[];
  deployerChangeScript: Buffer;

  creatorScript?: Buffer;

  feeScript: Buffer;
  minerFeeSats: Sats;
}): DeployResult {
  const creatorScript = params.creatorScript ?? params.deployerChangeScript;
  const tokenId = computeTokenId({ ...params.identity, creatorScript });
  const tokenIdHex = tokenId.toString("hex");
  const s0 = s0StateV2({ tokenId: tokenIdHex });
  const vault = buildBackingVaultV3({
    state: s0,
    guardianXOnly: params.guardianXOnly,
    recoveryKeyXOnly: params.recoveryKeyXOnly,
    recoveryProfile: params.recoveryProfile,
    network: params.network,
  });
  const wire = encodeDeployV2({
    policyVersion: COVE_POLICY_V3,
    ticker: params.identity.ticker,
    tokenNonce: params.identity.tokenNonce,
  });

  const psbt = new bitcoin.Psbt({ network: params.network });
  for (const input of params.deployerInputs) {
    psbt.addInput(psbtInputFor(input, params.network));
  }
  psbt.addOutput({
    script: Buffer.concat([Buffer.from([0x6a, wire.length]), wire]),
    value: 0,
  });
  psbt.addOutput({
    script: vault.scriptPubKey,
    value: Number(RESERVE_ANCHOR_SATS),
  });

  psbt.addOutput({ script: creatorScript, value: Number(CREATOR_RECORD_SATS) });

  psbt.addOutput({ script: params.feeScript, value: Number(LAUNCH_FEE_SATS) });

  const totalIn = params.deployerInputs.reduce((s, i) => s + i.valueSats, 0n);
  const change =
    totalIn -
    RESERVE_ANCHOR_SATS -
    CREATOR_RECORD_SATS -
    LAUNCH_FEE_SATS -
    params.minerFeeSats;
  if (change < 0n) throw new Error("insufficient deployer funds");
  const settled = addChangeOrAbsorb(
    psbt,
    params.deployerChangeScript,
    change,
    params.minerFeeSats,
  );

  return { psbt, tokenId, s0, vault, wire, minerFeeSats: settled.minerFeeSats };
}

export interface MintResult {
  psbt: bitcoin.Psbt;
  prevVault: CoveVaultV3;
  nextState: CoveStateV2;
  nextVault: CoveVaultV3;
  grossSats: Sats;
  buyFeeSats: Sats;
  creatorFeeSats: Sats;
  wire: Buffer;
  stateInputIndex: number;

  minerFeeSats: Sats;
}

export function buildMintPsbtV3(params: {
  network: bitcoin.networks.Network;
  tokenId: Buffer;
  prevState: CoveStateV2;
  prevBacking: ResolvedInput;
  mintAmountAtoms: bigint;
  guardianXOnly: Buffer;
  recoveryKeyXOnly: Buffer;
  recoveryProfile?: VaultRecoveryProfile;
  buyerInputs: ResolvedInput[];
  buyerCarrierScript: Buffer;
  buyerChangeScript: Buffer;
  feeScript: Buffer;

  creatorScript: Buffer;

  creatorFeeBps?: bigint;
  minerFeeSats: Sats;

  buyFeeBps?: bigint;

  buyFeeFlatSats?: bigint;

  discoveryEnvelope?: { ticker: string };
}): MintResult {
  const { nextState, grossSats } = applyMintV2(
    params.prevState,
    params.mintAmountAtoms,
  );
  const prevVault = buildBackingVaultV3({
    state: params.prevState,
    guardianXOnly: params.guardianXOnly,
    recoveryKeyXOnly: params.recoveryKeyXOnly,
    recoveryProfile: params.recoveryProfile,
    network: params.network,
  });
  const nextVault = buildBackingVaultV3({
    state: nextState,
    guardianXOnly: params.guardianXOnly,
    recoveryKeyXOnly: params.recoveryKeyXOnly,
    recoveryProfile: params.recoveryProfile,
    network: params.network,
  });
  const buyFeeSats = mintFeeSats(
    grossSats,
    params.mintAmountAtoms,
    params.buyFeeBps ?? COVE_FEE_CONFIG.buyFeeBps,
    params.buyFeeFlatSats ?? COVE_FEE_CONFIG.buyFeeFlatSats,
  );
  const wire = encodeMintV2({
    tokenId: params.tokenId,
    amount: params.mintAmountAtoms,
    recipientVout: 2,
  });

  const psbt = new bitcoin.Psbt({ network: params.network });
  psbt.addInput({
    hash: params.prevBacking.txid,
    index: params.prevBacking.vout,
    witnessUtxo: {
      script: params.prevBacking.script,
      value: Number(params.prevBacking.valueSats),
    },
    tapInternalKey: prevVault.numsKey,
    tapMerkleRoot: prevVault.merkleRoot,
    tapLeafScript: [
      {
        leafVersion: 0xc0,
        script: prevVault.mintLeaf.script,
        controlBlock: prevVault.mintControlBlock,
      },
    ],
  });
  for (const input of params.buyerInputs) {
    psbt.addInput(psbtInputFor(input, params.network));
  }

  psbt.addOutput({
    script: Buffer.concat([Buffer.from([0x6a, wire.length]), wire]),
    value: 0,
  });
  psbt.addOutput({
    script: nextVault.scriptPubKey,
    value: Number(RESERVE_ANCHOR_SATS + nextState.backingSats),
  });
  psbt.addOutput({
    script: params.buyerCarrierScript,
    value: Number(TOKEN_CARRIER_SATS),
  });
  psbt.addOutput({ script: params.feeScript, value: Number(buyFeeSats) });
  const creatorFee = creatorFeeSats(
    grossSats,
    params.creatorFeeBps ?? COVE_FEE_CONFIG.creatorFeeBps,
  );
  psbt.addOutput({ script: params.creatorScript, value: Number(creatorFee) });

  const totalIn =
    params.prevBacking.valueSats +
    params.buyerInputs.reduce((s, i) => s + i.valueSats, 0n);
  const change =
    totalIn -
    (RESERVE_ANCHOR_SATS + nextState.backingSats) -
    TOKEN_CARRIER_SATS -
    buyFeeSats -
    creatorFee -
    params.minerFeeSats;
  if (change < 0n) throw new Error("insufficient buyer funds");
  const settled = addChangeOrAbsorb(
    psbt,
    params.buyerChangeScript,
    change,
    params.minerFeeSats,
  );

  if (params.discoveryEnvelope) {
    const discovery = encodeDiscovery(
      decodeV2(wire),
      params.discoveryEnvelope.ticker,
    );
    psbt.addOutput({
      script: Buffer.concat([Buffer.from([0x6a, discovery.length]), discovery]),
      value: 0,
    });
  }

  return {
    psbt,
    prevVault,
    nextState,
    nextVault,
    grossSats,
    buyFeeSats,
    creatorFeeSats: creatorFee,
    wire,
    stateInputIndex: 0,
    minerFeeSats: settled.minerFeeSats,
  };
}

export interface TransferResult {
  psbt: bitcoin.Psbt;
  wire: Buffer;

  allocations: { vout: number; amount: bigint }[];

  tokenOutputs: { vout: number; script: Buffer; amountAtoms: bigint }[];

  minerFeeSats: Sats;
}

export function buildTransferPsbtV2(params: {
  network: bitcoin.networks.Network;
  tokenId: Buffer;
  tokenInputs: ResolvedInput[];

  tokenInputTotalAtoms: bigint;

  tokenOutputs: { script: Buffer; amountAtoms: bigint }[];

  funderInputs: ResolvedInput[];
  funderChangeScript: Buffer;

  btcOutputs: { script: Buffer; valueSats: Sats }[];
  minerFeeSats: Sats;
}): TransferResult {
  if (params.tokenOutputs.length === 0) throw new Error("no token outputs");
  if (params.tokenOutputs.length > 4) throw new Error("max 4 token outputs");
  const tokenOutTotal = params.tokenOutputs.reduce(
    (s, o) => s + o.amountAtoms,
    0n,
  );
  if (tokenOutTotal !== params.tokenInputTotalAtoms)
    throw new Error(
      `token conservation violated: in=${params.tokenInputTotalAtoms} out=${tokenOutTotal}`,
    );

  let vout = 0;
  const wire = encodeTransferV2({
    tokenId: params.tokenId,
    allocations: params.tokenOutputs.map((o) => ({
      vout: ++vout,
      amount: o.amountAtoms,
    })),
  });

  const psbt = new bitcoin.Psbt({ network: params.network });
  for (const input of [...params.tokenInputs, ...params.funderInputs]) {
    psbt.addInput(psbtInputFor(input, params.network));
  }

  psbt.addOutput({
    script: Buffer.concat([Buffer.from([0x6a, wire.length]), wire]),
    value: 0,
  });
  const tokenOutputs: TransferResult["tokenOutputs"] = [];
  for (const o of params.tokenOutputs) {
    tokenOutputs.push({
      vout: psbt.txOutputs.length,
      script: o.script,
      amountAtoms: o.amountAtoms,
    });
    psbt.addOutput({ script: o.script, value: Number(TOKEN_CARRIER_SATS) });
  }
  for (const o of params.btcOutputs) {
    psbt.addOutput({ script: o.script, value: Number(o.valueSats) });
  }

  const totalIn = [...params.tokenInputs, ...params.funderInputs].reduce(
    (s, i) => s + i.valueSats,
    0n,
  );
  const carriersOut = BigInt(params.tokenOutputs.length) * TOKEN_CARRIER_SATS;
  const btcOut = params.btcOutputs.reduce((s, o) => s + o.valueSats, 0n);
  const change = totalIn - carriersOut - btcOut - params.minerFeeSats;
  if (change < 0n) throw new Error("insufficient transfer funds");
  const settled = addChangeOrAbsorb(
    psbt,
    params.funderChangeScript,
    change,
    params.minerFeeSats,
  );

  const allocations = params.tokenOutputs.map((o, i) => ({
    vout: i + 1,
    amount: o.amountAtoms,
  }));
  return {
    psbt,
    wire,
    allocations,
    tokenOutputs,
    minerFeeSats: settled.minerFeeSats,
  };
}

export interface RedeemResult {
  psbt: bitcoin.Psbt;
  prevVault: CoveVaultV3;
  nextState: CoveStateV2;
  nextVault: CoveVaultV3;
  grossSats: Sats;
  redeemFeeSats: Sats;
  netSats: Sats;
  payoutSats: Sats;
  changeAtoms: bigint;
  wire: Buffer;

  minerFeeSats: Sats;
}

export function buildRedeemPsbtV3(params: {
  network: bitcoin.networks.Network;
  tokenId: Buffer;
  prevState: CoveStateV2;
  prevBacking: ResolvedInput;
  redeemAmountAtoms: bigint;
  tokenInputs: ResolvedInput[];
  tokenInputTotalAtoms: bigint;
  guardianXOnly: Buffer;
  recoveryKeyXOnly: Buffer;
  recoveryProfile?: VaultRecoveryProfile;
  sellerPayoutScript: Buffer;
  sellerChangeScript: Buffer;
  feeScript: Buffer;
  minerFeeSats: Sats;

  funderInputs?: ResolvedInput[];

  funderChangeScript?: Buffer;

  redeemFeeBps?: bigint;

  redeemFeeFlatSats?: bigint;

  walletFundedFees?: boolean;
}): RedeemResult {
  const { nextState, grossSats } = applyRedeemV2(
    params.prevState,
    params.redeemAmountAtoms,
  );
  const prevVault = buildBackingVaultV3({
    state: params.prevState,
    guardianXOnly: params.guardianXOnly,
    recoveryKeyXOnly: params.recoveryKeyXOnly,
    recoveryProfile: params.recoveryProfile,
    network: params.network,
  });
  const nextVault = buildBackingVaultV3({
    state: nextState,
    guardianXOnly: params.guardianXOnly,
    recoveryKeyXOnly: params.recoveryKeyXOnly,
    recoveryProfile: params.recoveryProfile,
    network: params.network,
  });
  const redeemFeeSats = redeemFeeOf(
    grossSats,
    params.redeemFeeBps ?? COVE_FEE_CONFIG.redeemFeeBps,
    params.redeemFeeFlatSats ?? COVE_FEE_CONFIG.redeemFeeFlatSats,
  );
  const netSats = grossSats - redeemFeeSats;
  const changeAtoms = params.tokenInputTotalAtoms - params.redeemAmountAtoms;
  if (changeAtoms < 0n) throw new Error("redeem exceeds token input");

  const changeCarrierVout = 4;
  const wire = encodeRedeemV2({
    tokenId: params.tokenId,
    redeemAmount: params.redeemAmountAtoms,
    changeAllocations:
      changeAtoms > 0n
        ? [{ vout: changeCarrierVout, amount: changeAtoms }]
        : [],
  });

  const psbt = new bitcoin.Psbt({ network: params.network });
  psbt.addInput({
    hash: params.prevBacking.txid,
    index: params.prevBacking.vout,
    witnessUtxo: {
      script: params.prevBacking.script,
      value: Number(params.prevBacking.valueSats),
    },
    tapInternalKey: prevVault.numsKey,
    tapMerkleRoot: prevVault.merkleRoot,
    tapLeafScript: [
      {
        leafVersion: 0xc0,
        script: prevVault.redeemLeaf.script,
        controlBlock: prevVault.redeemControlBlock,
      },
    ],
  });
  for (const input of params.tokenInputs) {
    psbt.addInput(psbtInputFor(input, params.network));
  }

  for (const input of params.funderInputs ?? []) {
    psbt.addInput(psbtInputFor(input, params.network));
  }

  psbt.addOutput({
    script: Buffer.concat([Buffer.from([0x6a, wire.length]), wire]),
    value: 0,
  });
  psbt.addOutput({
    script: nextVault.scriptPubKey,
    value: Number(RESERVE_ANCHOR_SATS + nextState.backingSats),
  });
  const funderTotal = (params.funderInputs ?? []).reduce(
    (s, i) => s + i.valueSats,
    0n,
  );
  const totalIn =
    params.prevBacking.valueSats +
    params.tokenInputs.reduce((s, i) => s + i.valueSats, 0n) +
    funderTotal;
  const successorValue = RESERVE_ANCHOR_SATS + nextState.backingSats;
  const changeCarrierValue = changeAtoms > 0n ? TOKEN_CARRIER_SATS : 0n;
  const payoutSats = params.walletFundedFees
    ? totalIn -
      successorValue -
      redeemFeeSats -
      changeCarrierValue -
      params.minerFeeSats
    : netSats;
  if (
    params.walletFundedFees &&
    (payoutSats < grossSats ||
      payoutSats < dustThreshold(params.sellerPayoutScript))
  )
    throw new Error(
      "insufficient redeem funds; add a BTC funding input to pay fees and return standard BTC change",
    );
  if (
    params.walletFundedFees &&
    params.funderChangeScript &&
    !params.funderChangeScript.equals(params.sellerPayoutScript)
  )
    throw new Error(
      "wallet-funded redeem must return BTC change to the payout address",
    );
  psbt.addOutput({
    script: params.sellerPayoutScript,
    value: Number(payoutSats),
  });
  psbt.addOutput({ script: params.feeScript, value: Number(redeemFeeSats) });
  if (changeAtoms > 0n)
    psbt.addOutput({
      script: params.sellerChangeScript,
      value: Number(TOKEN_CARRIER_SATS),
    });
  const change =
    totalIn -
    successorValue -
    payoutSats -
    redeemFeeSats -
    changeCarrierValue -
    params.minerFeeSats;
  if (change < 0n)
    throw new Error(
      `insufficient redeem funds: need ${-change} more sats; add a BTC funding input`,
    );
  const settled = params.walletFundedFees
    ? { minerFeeSats: params.minerFeeSats }
    : addChangeOrAbsorb(
        psbt,
        params.funderChangeScript ?? params.sellerChangeScript,
        change,
        params.minerFeeSats,
      );

  return {
    psbt,
    prevVault,
    nextState,
    nextVault,
    grossSats,
    redeemFeeSats,
    payoutSats,
    netSats,
    changeAtoms,
    wire,
    minerFeeSats: settled.minerFeeSats,
  };
}

export { grossBuy, COVE_FEE_CONFIG };
