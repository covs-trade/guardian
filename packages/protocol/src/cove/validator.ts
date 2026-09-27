import {
  ATOMS_PER_TOKEN,
  PUBLIC_SUPPLY_ATOMS,
  computePlatformFee,
  getStageForSupply,
  quoteExactTokens,
} from "@crclaunch/curve";
import type { Atoms, Sats } from "@crclaunch/curve";
import { dustThreshold, isP2TR, isP2WPKH } from "@crclaunch/bitcoin";
import type { CoveConfig } from "./config.js";
import type {
  CoveState,
  CoveTransaction,
  CoveToken,
  CoveValidationResult,
} from "./types.js";
export function isSupportedScript(scriptHex: string): boolean {
  const script = Buffer.from(scriptHex, "hex");
  return isP2WPKH(script) || isP2TR(script);
}
function atomsToDisplayTokens(atoms: Atoms): Atoms {
  return atoms / ATOMS_PER_TOKEN;
}
function displayTokensToAtoms(tokens: Atoms): Atoms {
  return tokens * ATOMS_PER_TOKEN;
}
function resolveToken(
  state: CoveState,
  ticker?: string,
): CoveToken | undefined {
  if (!ticker) return undefined;
  const deploymentId = state.tickerIndex.get(ticker);
  return deploymentId ? state.tokens.get(deploymentId) : undefined;
}
function anchorIsDustSafe(
  output:
    | {
        scriptPubKeyHex: string;
        amountSats: Sats;
      }
    | undefined,
): boolean {
  if (!output) return false;
  const dust = dustThreshold(Buffer.from(output.scriptPubKeyHex, "hex"));
  return output.amountSats >= dust;
}
export function validateCoveOperation(
  state: CoveState,
  tx: CoveTransaction,
  cfg: CoveConfig,
): CoveValidationResult {
  switch (tx.operation) {
    case "DEPLOY":
      return validateDeploy(state, tx, cfg);
    case "MINT":
      return validateMint(state, tx, cfg);
    case "TRANSFER":
      return validateTransfer(state, tx, cfg);
    default:
      return { valid: false, reason: "UNSUPPORTED_OPERATION" };
  }
}
function validateDeploy(
  state: CoveState,
  tx: CoveTransaction,
  cfg: CoveConfig,
): CoveValidationResult {
  const tick = tx.ticker ?? "";
  if (!/^[A-Z0-9]{4}$/.test(tick))
    return { valid: false, reason: "INVALID_TICKER" };
  if (state.tickerIndex.has(tick))
    return { valid: false, reason: "TICKER_TAKEN" };
  if (!isSupportedScript(tx.actor))
    return { valid: false, reason: "UNSUPPORTED_ACTOR_SCRIPT" };
  const feeOut = tx.protocolOutputs.find((o) => o.role === "launch-fee");
  if (!feeOut || feeOut.index !== 1)
    return { valid: false, reason: "INVALID_OUTPUT_LAYOUT" };
  if (feeOut.scriptPubKeyHex !== cfg.treasuryScript)
    return { valid: false, reason: "WRONG_TREASURY" };
  if (feeOut.amountSats !== cfg.launchFeeSats) {
    return {
      valid: false,
      reason:
        feeOut.amountSats < cfg.launchFeeSats ? "UNDERPAYMENT" : "OVERPAYMENT",
    };
  }
  return { valid: true, reason: null };
}
function validateMint(
  state: CoveState,
  tx: CoveTransaction,
  cfg: CoveConfig,
): CoveValidationResult {
  const token = resolveToken(state, tx.ticker);
  if (!token) return { valid: false, reason: "UNKNOWN_DEPLOYMENT" };
  if (tx.supplyBeforeAtoms === undefined)
    return { valid: false, reason: "MISSING_SUPPLY" };
  if (tx.supplyBeforeAtoms !== token.confirmedSupplyAtoms) {
    return { valid: false, reason: "STALE_SUPPLY" };
  }
  const amount = tx.amountAtoms ?? 0n;
  if (amount <= 0n) return { valid: false, reason: "ZERO_AMOUNT" };
  if (amount % ATOMS_PER_TOKEN !== 0n)
    return { valid: false, reason: "SUBTOKEN_MINT_UNSUPPORTED" };
  if (!isSupportedScript(tx.actor))
    return { valid: false, reason: "UNSUPPORTED_ACTOR_SCRIPT" };
  if (!tx.recipient || !isSupportedScript(tx.recipient)) {
    return { valid: false, reason: "INVALID_RECIPIENT" };
  }
  const amountDisplay = atomsToDisplayTokens(amount);
  const confirmedDisplay = atomsToDisplayTokens(token.confirmedSupplyAtoms);
  const remainingDisplay = atomsToDisplayTokens(
    token.publicSupplyAtoms - token.confirmedSupplyAtoms,
  );
  if (amountDisplay > remainingDisplay)
    return { valid: false, reason: "OVERMINT" };
  const quote = quoteExactTokens({
    desiredTokens: amountDisplay,
    currentSupply: confirmedDisplay,
  });
  const requiredCurve = quote.curveContributionSats;
  if (requiredCurve < cfg.minContributionSats) {
    return { valid: false, reason: "BELOW_MIN_CONTRIBUTION" };
  }
  const requiredPlatform = computePlatformFee(
    requiredCurve,
    cfg.primaryMintFeeBps,
  );
  const requiredSettlement = requiredCurve + requiredPlatform;
  const recipientOut = tx.protocolOutputs.find((o) => o.role === "recipient");
  if (!recipientOut || recipientOut.index !== 1)
    return { valid: false, reason: "INVALID_OUTPUT_LAYOUT" };
  if (recipientOut.scriptPubKeyHex !== tx.recipient)
    return { valid: false, reason: "WRONG_RECIPIENT" };
  if (!anchorIsDustSafe(recipientOut))
    return { valid: false, reason: "RECIPIENT_ANCHOR_DUST" };
  const settlementOut = tx.protocolOutputs.find((o) => o.role === "settlement");
  if (!settlementOut || settlementOut.index !== 2)
    return { valid: false, reason: "INVALID_OUTPUT_LAYOUT" };
  if (settlementOut.scriptPubKeyHex !== cfg.settlementScript) {
    return { valid: false, reason: "WRONG_SETTLEMENT_SCRIPT" };
  }
  if (settlementOut.amountSats !== requiredSettlement) {
    return {
      valid: false,
      reason:
        settlementOut.amountSats < requiredSettlement
          ? "UNDERPAYMENT"
          : "OVERPAYMENT",
    };
  }
  return { valid: true, reason: null };
}
function validateTransfer(
  state: CoveState,
  tx: CoveTransaction,
  _cfg: CoveConfig,
): CoveValidationResult {
  const token = resolveToken(state, tx.ticker);
  if (!token) return { valid: false, reason: "UNKNOWN_DEPLOYMENT" };
  const amount = tx.amountAtoms ?? 0n;
  if (amount <= 0n) return { valid: false, reason: "ZERO_AMOUNT" };
  if (!isSupportedScript(tx.actor))
    return { valid: false, reason: "UNSUPPORTED_ACTOR_SCRIPT" };
  if (!tx.recipient || !isSupportedScript(tx.recipient)) {
    return { valid: false, reason: "INVALID_RECIPIENT" };
  }
  if (tx.recipient === tx.actor)
    return { valid: false, reason: "SELF_TRANSFER" };
  const senderBal = state.balances.get(tx.actor)?.get(token.deploymentId);
  const available = senderBal ? senderBal.availableAtoms : 0n;
  if (available < amount)
    return { valid: false, reason: "INSUFFICIENT_AVAILABLE_TOKENS" };
  const recipientOut = tx.protocolOutputs.find((o) => o.role === "recipient");
  if (!recipientOut || recipientOut.index !== 1)
    return { valid: false, reason: "INVALID_OUTPUT_LAYOUT" };
  if (recipientOut.scriptPubKeyHex !== tx.recipient)
    return { valid: false, reason: "WRONG_RECIPIENT" };
  if (!anchorIsDustSafe(recipientOut))
    return { valid: false, reason: "RECIPIENT_ANCHOR_DUST" };
  const continuationOut = tx.protocolOutputs.find(
    (o) => o.role === "continuation",
  );
  if (!continuationOut || continuationOut.index !== 2) {
    return { valid: false, reason: "MISSING_CONTINUATION" };
  }
  if (continuationOut.scriptPubKeyHex !== tx.actor) {
    return { valid: false, reason: "WRONG_CONTINUATION" };
  }
  if (!anchorIsDustSafe(continuationOut))
    return { valid: false, reason: "CONTINUATION_DUST" };
  return { valid: true, reason: null };
}
export function applyCoveOperation(
  state: CoveState,
  tx: CoveTransaction,
  cfg: CoveConfig,
): void {
  switch (tx.operation) {
    case "DEPLOY": {
      const tick = tx.ticker!;
      const token: CoveToken = {
        deploymentId: tx.txid,
        ticker: tick,
        creator: tx.actor,
        confirmedSupplyAtoms: 0n,
        publicSupplyAtoms: PUBLIC_SUPPLY_ATOMS,
        currentStage: 1,
      };
      state.tokens.set(tx.txid, token);
      state.tickerIndex.set(tick, tx.txid);
      state.platformTreasurySats += cfg.launchFeeSats;
      return;
    }
    case "MINT": {
      const token = resolveToken(state, tx.ticker)!;
      const amount = tx.amountAtoms!;
      const quote = quoteExactTokens({
        desiredTokens: atomsToDisplayTokens(amount),
        currentSupply: atomsToDisplayTokens(token.confirmedSupplyAtoms),
      });
      const requiredCurve = quote.curveContributionSats;
      const requiredPlatform = computePlatformFee(
        requiredCurve,
        cfg.primaryMintFeeBps,
      );
      token.confirmedSupplyAtoms += amount;
      token.currentStage = getStageForSupply(
        atomsToDisplayTokens(token.confirmedSupplyAtoms),
      );
      state.reserveSats += requiredCurve;
      state.platformTreasurySats += requiredPlatform;
      let bal = state.balances.get(tx.recipient!);
      if (!bal) {
        bal = new Map();
        state.balances.set(tx.recipient!, bal);
      }
      const cur = bal.get(token.deploymentId) ?? { availableAtoms: 0n };
      bal.set(token.deploymentId, {
        availableAtoms: cur.availableAtoms + amount,
      });
      return;
    }
    case "TRANSFER": {
      const token = resolveToken(state, tx.ticker)!;
      const amount = tx.amountAtoms!;
      const senderMap = state.balances.get(tx.actor)!;
      const sender = senderMap.get(token.deploymentId)!;
      sender.availableAtoms -= amount;
      if (sender.availableAtoms === 0n) {
        senderMap.delete(token.deploymentId);
        if (senderMap.size === 0) state.balances.delete(tx.actor);
      }
      let recv = state.balances.get(tx.recipient!);
      if (!recv) {
        recv = new Map();
        state.balances.set(tx.recipient!, recv);
      }
      const cur = recv.get(token.deploymentId) ?? { availableAtoms: 0n };
      recv.set(token.deploymentId, {
        availableAtoms: cur.availableAtoms + amount,
      });
      return;
    }
  }
}
export { displayTokensToAtoms };
