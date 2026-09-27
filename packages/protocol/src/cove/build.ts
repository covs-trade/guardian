import type { ChainUtxo, CovePsbt, NetworkName } from "@crclaunch/bitcoin";
import {
  buildUnsignedPsbt,
  dustThreshold,
  opReturnScriptData,
} from "@crclaunch/bitcoin";
import {
  ATOMS_PER_TOKEN,
  computePlatformFee,
  quoteExactTokens,
} from "@crclaunch/curve";
import type { Atoms } from "@crclaunch/curve";
import type { CoveConfig } from "./config.js";
import {
  encodeCoveDeploy,
  encodeCoveMint,
  encodeCoveTransfer,
} from "./envelope.js";
export function anchorAmount(scriptPubKeyHex: string): bigint {
  return dustThreshold(Buffer.from(scriptPubKeyHex, "hex"));
}
export interface BuildDeployParams {
  network: NetworkName;
  ticker: string;
  inputs: ChainUtxo[];
  changeAddress: string;
  feeRateSatVb: bigint;
  config: CoveConfig;
}
export interface BuildMintParams {
  network: NetworkName;
  ticker: string;
  amountAtoms: Atoms;
  supplyBeforeAtoms: Atoms;
  recipientScriptHex: string;
  inputs: ChainUtxo[];
  changeAddress: string;
  feeRateSatVb: bigint;
  config: CoveConfig;
}
export interface BuildTransferParams {
  network: NetworkName;
  ticker: string;
  amountAtoms: Atoms;
  recipientScriptHex: string;
  actorScriptHex: string;
  inputs: ChainUtxo[];
  changeAddress: string;
  feeRateSatVb: bigint;
  config: CoveConfig;
}
export function buildCoveDeployPsbt(p: BuildDeployParams): CovePsbt {
  const envelope = encodeCoveDeploy(p.ticker);
  return buildUnsignedPsbt({
    network: p.network,
    inputs: p.inputs,
    outputs: [
      { script: opReturnScriptData(envelope), valueSats: 0n },
      {
        script: Buffer.from(p.config.treasuryScript, "hex"),
        valueSats: p.config.launchFeeSats,
      },
    ],
    changeAddress: p.changeAddress,
    feeRateSatVb: p.feeRateSatVb,
    maxFeeRateSatVb: p.config.maxFeeRateSatVb,
    maxMinerFeeSats: p.config.maxMinerFeeSats,
  });
}
export function buildCoveMintPsbt(p: BuildMintParams): CovePsbt {
  if (p.amountAtoms <= 0n || p.amountAtoms % ATOMS_PER_TOKEN !== 0n) {
    throw new Error(
      "SUBTOKEN_MINT_UNSUPPORTED: amount must be a whole display token in atoms.",
    );
  }
  const quote = quoteExactTokens({
    desiredTokens: p.amountAtoms / ATOMS_PER_TOKEN,
    currentSupply: p.supplyBeforeAtoms / ATOMS_PER_TOKEN,
  });
  const curve = quote.curveContributionSats;
  if (curve < p.config.minContributionSats) {
    throw new Error("BELOW_MIN_CONTRIBUTION: mint contribution below minimum.");
  }
  const fee = computePlatformFee(curve, p.config.primaryMintFeeBps);
  const settlement = curve + fee;
  const envelope = encodeCoveMint(p.ticker, p.amountAtoms, p.supplyBeforeAtoms);
  return buildUnsignedPsbt({
    network: p.network,
    inputs: p.inputs,
    outputs: [
      { script: opReturnScriptData(envelope), valueSats: 0n },
      {
        script: Buffer.from(p.recipientScriptHex, "hex"),
        valueSats: anchorAmount(p.recipientScriptHex),
      },
      {
        script: Buffer.from(p.config.settlementScript, "hex"),
        valueSats: settlement,
      },
    ],
    changeAddress: p.changeAddress,
    feeRateSatVb: p.feeRateSatVb,
    maxFeeRateSatVb: p.config.maxFeeRateSatVb,
    maxMinerFeeSats: p.config.maxMinerFeeSats,
  });
}
export function buildCoveTransferPsbt(p: BuildTransferParams): CovePsbt {
  const envelope = encodeCoveTransfer(p.ticker, p.amountAtoms);
  return buildUnsignedPsbt({
    network: p.network,
    inputs: p.inputs,
    outputs: [
      { script: opReturnScriptData(envelope), valueSats: 0n },
      {
        script: Buffer.from(p.recipientScriptHex, "hex"),
        valueSats: anchorAmount(p.recipientScriptHex),
      },
      {
        script: Buffer.from(p.actorScriptHex, "hex"),
        valueSats: anchorAmount(p.actorScriptHex),
      },
    ],
    changeAddress: p.changeAddress,
    feeRateSatVb: p.feeRateSatVb,
    maxFeeRateSatVb: p.config.maxFeeRateSatVb,
    maxMinerFeeSats: p.config.maxMinerFeeSats,
  });
}
