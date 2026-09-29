import type { CoreRpcProvider, RpcReadOptions } from "./provider.js";

export class FeeError extends Error {
  readonly code: "MINER_FEE_TOO_LOW" | "MINER_FEE_TOO_HIGH";
  constructor(
    code: "MINER_FEE_TOO_LOW" | "MINER_FEE_TOO_HIGH",
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = "FeeError";
    this.code = code;
  }
}

export const VB_TX_OVERHEAD = 11;

export const VB_INPUT_P2WPKH = 68;

export const VB_INPUT_P2TR_KEYPATH = 58;

export const VB_INPUT_P2SH_P2WPKH = 91;

export const VB_INPUT_VAULT = 100;

export function outputVbytes(scriptBytes: number): number {
  return 9 + scriptBytes;
}

export const SCRIPT_BYTES_P2TR = 34;

export interface CoveTxShape {
  vaultInputs: number;

  p2wpkhInputs: number;

  p2trInputs?: number;

  p2shP2wpkhInputs?: number;

  outputScriptBytes: readonly number[];
}

export function estimateVsize(shape: CoveTxShape): number {
  const inputs =
    shape.vaultInputs * VB_INPUT_VAULT +
    shape.p2wpkhInputs * VB_INPUT_P2WPKH +
    (shape.p2trInputs ?? 0) * VB_INPUT_P2TR_KEYPATH +
    (shape.p2shP2wpkhInputs ?? 0) * VB_INPUT_P2SH_P2WPKH;
  const outputs = shape.outputScriptBytes.reduce(
    (sum, len) => sum + outputVbytes(len),
    0,
  );
  return VB_TX_OVERHEAD + inputs + outputs;
}

export type FeeTierKey = "eco" | "standard" | "priority";

export interface FeeTier {
  key: FeeTierKey;
  label: string;

  blocks: number;
  satPerVb: bigint;
}

export interface FeeRates {
  floorSatPerVb: bigint;

  ceilingSatPerVb: bigint;
  tiers: FeeTier[];

  estimated: boolean;
}

export const ABSOLUTE_FLOOR_SAT_PER_VB = 1n;

export const ABSOLUTE_CEILING_SAT_PER_VB = 500n;

const TIER_TARGETS: { key: FeeTierKey; label: string; blocks: number }[] = [
  { key: "eco", label: "Eco", blocks: 12 },
  { key: "standard", label: "Standard", blocks: 3 },
  { key: "priority", label: "Priority", blocks: 1 },
];

const FALLBACK_SAT_PER_VB: Record<FeeTierKey, bigint> = {
  eco: 2n,
  standard: 5n,
  priority: 10n,
};

export async function loadFeeRates(
  provider: CoreRpcProvider,
  options?: RpcReadOptions,
  mode: "node" | "relay-floor-fallback" = "node",
): Promise<FeeRates> {
  const [floor, estimates] = await Promise.all([
    provider.getMempoolMinFeeSatPerVb(options),
    mode === "relay-floor-fallback"
      ? Promise.resolve(TIER_TARGETS.map(() => null))
      : Promise.all(
          TIER_TARGETS.map((target) =>
            provider.estimateFeeRateAt(target.blocks, options),
          ),
        ),
  ]);
  const floorRaw = floor;
  const floorSatPerVb =
    floorRaw > ABSOLUTE_FLOOR_SAT_PER_VB ? floorRaw : ABSOLUTE_FLOOR_SAT_PER_VB;

  let estimated = false;
  const tiers: FeeTier[] = [];
  let previous = 0n;

  for (const [index, target] of TIER_TARGETS.entries()) {
    let rate = estimates[index] ?? null;
    if (rate === null) {
      estimated = true;
      rate = FALLBACK_SAT_PER_VB[target.key];
    }
    if (rate < floorSatPerVb) rate = floorSatPerVb;
    if (rate > ABSOLUTE_CEILING_SAT_PER_VB) rate = ABSOLUTE_CEILING_SAT_PER_VB;
    if (rate < previous) rate = previous;
    previous = rate;
    tiers.push({
      key: target.key,
      label: target.label,
      blocks: target.blocks,
      satPerVb: rate,
    });
  }

  return {
    floorSatPerVb,
    ceilingSatPerVb: ABSOLUTE_CEILING_SAT_PER_VB,
    tiers,
    estimated,
  };
}

export interface ResolveMinerFeeInput {
  rateSatPerVb?: bigint;

  explicitSats?: bigint;

  vsize: number;
  floorSatPerVb: bigint;
  ceilingSatPerVb: bigint;

  maxMinerFeeSats: bigint;
}

export interface ResolvedMinerFee {
  minerFeeSats: bigint;
  vsize: number;
  effectiveSatPerVb: bigint;
}

export function resolveMinerFee(input: ResolveMinerFeeInput): ResolvedMinerFee {
  const vsize = BigInt(Math.max(1, Math.ceil(input.vsize)));

  let minerFeeSats: bigint;
  if (input.rateSatPerVb !== undefined) {
    if (input.rateSatPerVb <= 0n) {
      throw new FeeError("MINER_FEE_TOO_LOW", "fee rate must be positive");
    }
    minerFeeSats = input.rateSatPerVb * vsize;
  } else if (input.explicitSats !== undefined) {
    minerFeeSats = input.explicitSats;
  } else {
    throw new FeeError(
      "MINER_FEE_TOO_LOW",
      "no fee rate or fee amount supplied",
    );
  }

  const effectiveSatPerVb = minerFeeSats / vsize;

  if (effectiveSatPerVb < input.floorSatPerVb) {
    throw new FeeError(
      "MINER_FEE_TOO_LOW",
      `${minerFeeSats} sats over ${vsize} vbytes is ${effectiveSatPerVb} sat/vB, below the ` +
        `network's current relay floor of ${input.floorSatPerVb} sat/vB. This transaction ` +
        `would not confirm. Raise the fee to at least ${input.floorSatPerVb * vsize} sats.`,
    );
  }
  if (effectiveSatPerVb > input.ceilingSatPerVb) {
    throw new FeeError(
      "MINER_FEE_TOO_HIGH",
      `${minerFeeSats} sats over ${vsize} vbytes is ${effectiveSatPerVb} sat/vB, above the ` +
        `${input.ceilingSatPerVb} sat/vB ceiling. Nothing on Bitcoin needs that rate.`,
    );
  }
  if (minerFeeSats > input.maxMinerFeeSats) {
    throw new FeeError(
      "MINER_FEE_TOO_HIGH",
      `miner fee ${minerFeeSats} sats exceeds the ${input.maxMinerFeeSats}-sat cap`,
    );
  }

  return { minerFeeSats, vsize: Number(vsize), effectiveSatPerVb };
}
