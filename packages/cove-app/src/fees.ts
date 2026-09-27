import {
  estimateVsize,
  SCRIPT_BYTES_P2TR,
  type SpendKind,
} from "@crclaunch/bitcoin";
export const OP_RETURN_SCRIPT_BYTES = {
  DEPLOY: 50,
  BACKING_BUY: 47,
  REDEEM: 56,
  TRANSFER: 75,
} as const;
export const DISCOVERY_SCRIPT_BYTES = 75;
export type CoveOperation = "DEPLOY" | "BACKING_BUY" | "REDEEM" | "TRANSFER";
export interface OperationShapeInput {
  fundingInputs: number;
  fundingKind?: SpendKind;
  tokenInputs?: number;
  tokenKind?: SpendKind;
  walletScriptBytes: number;
  ordinalsScriptBytes?: number;
  feeScriptBytes: number;
  recipientCarriers?: number;
  discovery?: boolean;
}
function tally(
  into: {
    p2wpkhInputs: number;
    p2trInputs: number;
    p2shP2wpkhInputs: number;
  },
  count: number,
  kind: SpendKind = "p2wpkh",
): void {
  if (count <= 0) return;
  if (kind === "p2tr") into.p2trInputs += count;
  else if (kind === "p2sh-p2wpkh") into.p2shP2wpkhInputs += count;
  else into.p2wpkhInputs += count;
}
export function estimateOperationVsize(
  op: CoveOperation,
  input: OperationShapeInput,
): number {
  const wallet = input.walletScriptBytes;
  const carrier = input.ordinalsScriptBytes ?? wallet;
  const outputs: number[] = [OP_RETURN_SCRIPT_BYTES[op]];
  switch (op) {
    case "DEPLOY":
      outputs.push(SCRIPT_BYTES_P2TR, wallet, input.feeScriptBytes, wallet);
      break;
    case "BACKING_BUY":
      outputs.push(
        SCRIPT_BYTES_P2TR,
        carrier,
        input.feeScriptBytes,
        SCRIPT_BYTES_P2TR,
        wallet,
      );
      if (input.discovery) outputs.push(DISCOVERY_SCRIPT_BYTES);
      break;
    case "REDEEM":
      outputs.push(
        SCRIPT_BYTES_P2TR,
        wallet,
        input.feeScriptBytes,
        carrier,
        wallet,
      );
      break;
    case "TRANSFER":
      for (let i = 0; i < (input.recipientCarriers ?? 1); i++)
        outputs.push(carrier);
      outputs.push(carrier, wallet);
      break;
  }
  const inputs = { p2wpkhInputs: 0, p2trInputs: 0, p2shP2wpkhInputs: 0 };
  tally(inputs, input.fundingInputs, input.fundingKind);
  tally(inputs, input.tokenInputs ?? 0, input.tokenKind);
  return estimateVsize({
    vaultInputs: op === "BACKING_BUY" || op === "REDEEM" ? 1 : 0,
    ...inputs,
    outputScriptBytes: outputs,
  });
}
export {
  estimateVsize,
  loadFeeRates,
  resolveMinerFee,
  outputVbytes,
  FeeError,
  SCRIPT_BYTES_P2TR,
  VB_TX_OVERHEAD,
  VB_INPUT_P2WPKH,
  VB_INPUT_P2TR_KEYPATH,
  VB_INPUT_VAULT,
  ABSOLUTE_FLOOR_SAT_PER_VB,
  ABSOLUTE_CEILING_SAT_PER_VB,
  type CoveTxShape,
  type FeeRates,
  type FeeTier,
  type FeeTierKey,
} from "@crclaunch/bitcoin";
