import { createHash } from "node:crypto";
import type { Sats, DisplayTokens } from "@crclaunch/curve";
import {
  PUBLIC_SUPPLY_TOKENS,
  RESERVE_SUPPLY_TOKENS,
  TOTAL_SUPPLY_TOKENS,
  computePlatformFee,
  getStageForSupply,
  quoteExactTokens,
} from "@crclaunch/curve";
import type { Network } from "@crclaunch/config";
import type { ProtocolEventType } from "../types.js";
import type { ProtocolConfig } from "../validation/config.js";
import { DEFAULT_MOCK_PROTOCOL_CONFIG } from "../validation/config.js";
import {
  validateExactOutputs,
  type OpValidationResult,
} from "../validation/common.js";
import type {
  MockBlock,
  MockChainState,
  MockEvent,
  MockListing,
  MockToken,
  MockTx,
  WalletBalance,
} from "./types.js";
export const MOCK_FAUCET_SATS: Sats = 10n * 100000000n;
const TICKER_RE = /^[A-Z0-9]{4}$/;
function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}
export function createInitialState(
  network: Network,
  config?: ProtocolConfig,
): MockChainState {
  return {
    network,
    height: 0n,
    blocks: [],
    mempool: [],
    txs: {},
    tokens: {},
    tickerIndex: {},
    balances: {},
    listings: {},
    events: {},
    platformTreasurySats: 0n,
    protocolTreasurySats: 0n,
    config: config ?? DEFAULT_MOCK_PROTOCOL_CONFIG,
  };
}
export function ensureWallet(
  state: MockChainState,
  address: string,
): WalletBalance {
  let bal = state.balances[address];
  if (!bal) {
    bal = { btcSats: MOCK_FAUCET_SATS, tokens: {}, lockedTokens: {} };
    state.balances[address] = bal;
  }
  return bal;
}
export function getStateHash(state: MockChainState): string {
  const summary = Object.values(state.tokens)
    .map(
      (t) =>
        `${t.deploymentId}:${t.confirmedMintedAtoms}:${t.status}:${t.currentStage}`,
    )
    .sort()
    .join("|");
  return sha256(summary);
}
export function mineBlock(state: MockChainState): MockBlock {
  const prevHash =
    state.blocks.length > 0
      ? state.blocks[state.blocks.length - 1]!.hash
      : "genesis";
  const height = state.height + 1n;
  const hash = sha256(`mock:block:${height}:${prevHash}`);
  const block: MockBlock = { height, hash, parentHash: prevHash, txids: [] };
  for (const listing of Object.values(state.listings)) {
    if (listing.status === "OPEN" && height >= listing.expiryHeight) {
      listing.status = "EXPIRED";
    }
  }
  const pending = state.mempool.slice();
  state.mempool = [];
  for (const txid of pending) {
    const tx = state.txs[txid];
    if (!tx) continue;
    const result = applyTx(state, tx, height, hash);
    if (result === "CONFIRMED") {
      block.txids.push(tx.txid);
    }
  }
  state.blocks.push(block);
  state.height = height;
  return block;
}
function emitEvent(
  state: MockChainState,
  tx: MockTx,
  blockHeight: bigint,
  blockHash: string,
  eventType: ProtocolEventType,
  fields: {
    deploymentId?: string | null;
    walletFrom?: string | null;
    walletTo?: string | null;
    tokenAmountAtoms?: DisplayTokens | null;
    btcAmountSats?: Sats | null;
    payload?: unknown;
  },
): void {
  const key = `${tx.txid}:0`;
  const event: MockEvent = {
    network: state.network,
    blockHeight,
    blockHash,
    txid: tx.txid,
    eventIndex: 0,
    eventType,
    deploymentId: fields.deploymentId ?? null,
    walletFrom: fields.walletFrom ?? null,
    walletTo: fields.walletTo ?? null,
    tokenAmountAtoms: fields.tokenAmountAtoms ?? null,
    btcAmountSats: fields.btcAmountSats ?? null,
    payload: fields.payload ?? null,
    canonical: true,
  };
  state.events[key] = event;
}
function validateTx(
  state: MockChainState,
  tx: MockTx,
  blockHeight: bigint,
): OpValidationResult<unknown> {
  const signer = tx.signer ?? "";
  const p = tx.payload;
  switch (tx.op) {
    case "DEPLOY": {
      const tickerNorm = (p.ticker ?? "").toUpperCase();
      if (!TICKER_RE.test(tickerNorm))
        return { valid: false, reason: "INVALID_TICKER", normalized: null };
      if (state.tickerIndex[tickerNorm])
        return { valid: false, reason: "TICKER_TAKEN", normalized: null };
      if (!signer)
        return { valid: false, reason: "MISSING_SIGNER", normalized: null };
      if (p.creatorAddress && p.creatorAddress !== signer) {
        return { valid: false, reason: "SIGNER_MISMATCH", normalized: null };
      }
      const launchFee = state.config.launchFeeSats;
      const layoutError = validateExactOutputs(tx.outputs, [
        {
          index: 0,
          address: state.config.treasuryAddress,
          amountSats: launchFee,
          kind: "launch-fee",
        },
      ]);
      if (layoutError)
        return { valid: false, reason: layoutError, normalized: null };
      const walletBtc = state.balances[signer]?.btcSats ?? MOCK_FAUCET_SATS;
      if (walletBtc < launchFee + tx.feeSats) {
        return { valid: false, reason: "INSUFFICIENT_BTC", normalized: null };
      }
      return {
        valid: true,
        reason: null,
        normalized: {
          ticker: p.ticker ?? "",
          tickerNormalized: tickerNorm,
          name: p.name ?? null,
          creatorAddress: signer,
          launchFeeSats: launchFee,
        },
      };
    }
    case "MINT": {
      const token = state.tokens[p.deploymentId ?? ""];
      if (!token)
        return { valid: false, reason: "TOKEN_NOT_FOUND", normalized: null };
      if (token.status !== "LIVE")
        return { valid: false, reason: "MINT_SOLD_OUT", normalized: null };
      if (token.confirmedMintedAtoms !== (p.supplyBeforeAtoms ?? 0n)) {
        return { valid: false, reason: "SUPPLY_CHANGED", normalized: null };
      }
      if (
        p.ticker !== undefined &&
        p.ticker.toUpperCase() !== token.tickerNormalized
      ) {
        return { valid: false, reason: "TICKER_MISMATCH", normalized: null };
      }
      if (!signer)
        return { valid: false, reason: "MISSING_SIGNER", normalized: null };
      if (p.buyerAddress && p.buyerAddress !== signer) {
        return { valid: false, reason: "SIGNER_MISMATCH", normalized: null };
      }
      const amount = p.tokenAmountAtoms ?? 0n;
      if (amount <= 0n)
        return { valid: false, reason: "ZERO_QUANTITY", normalized: null };
      const remaining = PUBLIC_SUPPLY_TOKENS - token.confirmedMintedAtoms;
      if (amount > remaining)
        return {
          valid: false,
          reason: "EXCEEDS_REMAINING_SUPPLY",
          normalized: null,
        };
      const quote = quoteExactTokens({
        desiredTokens: amount,
        currentSupply: token.confirmedMintedAtoms,
      });
      const requiredCurve = quote.curveContributionSats;
      const requiredPlatform = computePlatformFee(
        requiredCurve,
        state.config.primaryMintFeeBps,
      );
      const layoutError = validateExactOutputs(tx.outputs, [
        {
          index: 0,
          address: state.config.reserveAddress,
          amountSats: requiredCurve,
          kind: "curve-reserve",
        },
        {
          index: 1,
          address: state.config.treasuryAddress,
          amountSats: requiredPlatform,
          kind: "platform-fee",
        },
      ]);
      if (layoutError)
        return { valid: false, reason: layoutError, normalized: null };
      const walletBtc = state.balances[signer]?.btcSats ?? MOCK_FAUCET_SATS;
      const total = requiredCurve + requiredPlatform + tx.feeSats;
      if (walletBtc < total)
        return { valid: false, reason: "INSUFFICIENT_BTC", normalized: null };
      return {
        valid: true,
        reason: null,
        normalized: {
          deploymentId: token.deploymentId,
          ticker: token.ticker,
          buyerAddress: signer,
          tokenAmountAtoms: amount,
          curveContributionSats: requiredCurve,
          platformFeeSats: requiredPlatform,
          minerFeeSats: tx.feeSats,
          startingStage: quote.startingStage,
          endingStage: quote.endingStage,
        },
      };
    }
    case "TRANSFER": {
      const token = state.tokens[p.deploymentId ?? ""];
      if (!token)
        return { valid: false, reason: "TOKEN_NOT_FOUND", normalized: null };
      const amount = p.tokenAmountAtoms ?? 0n;
      if (amount <= 0n)
        return { valid: false, reason: "ZERO_QUANTITY", normalized: null };
      if (!signer)
        return { valid: false, reason: "MISSING_SIGNER", normalized: null };
      const to = p.buyerAddress ?? p.sellerAddress ?? "";
      if (!to || to === signer)
        return { valid: false, reason: "INVALID_RECIPIENT", normalized: null };
      const fromWallet = state.balances[signer];
      const total = fromWallet?.tokens[token.deploymentId] ?? 0n;
      const locked = fromWallet?.lockedTokens[token.deploymentId] ?? 0n;
      const available = total - locked;
      if (available < amount) {
        return {
          valid: false,
          reason: "INSUFFICIENT_AVAILABLE_TOKENS",
          normalized: null,
        };
      }
      return {
        valid: true,
        reason: null,
        normalized: {
          deploymentId: token.deploymentId,
          from: signer,
          to,
          tokenAmountAtoms: amount,
        },
      };
    }
    case "DEX_ASK": {
      const token = state.tokens[p.deploymentId ?? ""];
      if (!token)
        return { valid: false, reason: "TOKEN_NOT_FOUND", normalized: null };
      if (token.status !== "GRADUATED")
        return { valid: false, reason: "NOT_GRADUATED", normalized: null };
      if (!signer)
        return { valid: false, reason: "MISSING_SIGNER", normalized: null };
      if (p.sellerAddress && p.sellerAddress !== signer) {
        return { valid: false, reason: "SIGNER_MISMATCH", normalized: null };
      }
      const amount = p.tokenAmountAtoms ?? 0n;
      if (amount <= 0n)
        return { valid: false, reason: "ZERO_QUANTITY", normalized: null };
      const askingPrice = p.askingPriceSats ?? 0n;
      if (askingPrice <= 0n)
        return { valid: false, reason: "ZERO_PRICE", normalized: null };
      const expiry = p.expiryHeight ?? 0n;
      if (expiry <= blockHeight)
        return {
          valid: false,
          reason: "EXPIRED_ON_CREATION",
          normalized: null,
        };
      const wallet = state.balances[signer];
      const available = wallet
        ? (wallet.tokens[token.deploymentId] ?? 0n) -
          (wallet.lockedTokens[token.deploymentId] ?? 0n)
        : 0n;
      if (available < amount)
        return {
          valid: false,
          reason: "INSUFFICIENT_TOKENS",
          normalized: null,
        };
      if (tx.outputs.length !== 0)
        return {
          valid: false,
          reason: "INVALID_OUTPUT_LAYOUT",
          normalized: null,
        };
      return {
        valid: true,
        reason: null,
        normalized: {
          listingId: tx.txid,
          deploymentId: token.deploymentId,
          sellerAddress: signer,
          tokenAmountAtoms: amount,
          askingPriceSats: askingPrice,
          expiryHeight: expiry,
        },
      };
    }
    case "DEX_BID": {
      const listing = state.listings[p.listingId ?? ""];
      if (!listing)
        return { valid: false, reason: "LISTING_NOT_FOUND", normalized: null };
      if (listing.status !== "OPEN")
        return {
          valid: false,
          reason: "LISTING_ALREADY_TAKEN",
          normalized: null,
        };
      if (blockHeight >= listing.expiryHeight)
        return { valid: false, reason: "LISTING_EXPIRED", normalized: null };
      if (!signer)
        return { valid: false, reason: "MISSING_SIGNER", normalized: null };
      if (p.buyerAddress && p.buyerAddress !== signer) {
        return { valid: false, reason: "SIGNER_MISMATCH", normalized: null };
      }
      if (signer === listing.sellerAddress)
        return { valid: false, reason: "SELF_BUY", normalized: null };
      const price = listing.askingPriceSats;
      const requiredProtocolFee = computePlatformFee(
        price,
        state.config.marketplaceFeeBps,
      );
      const requiredPlatformFee = 0n;
      const expectedOutputs: {
        index: number;
        address: string;
        amountSats: bigint;
        kind: string;
      }[] = [
        {
          index: 0,
          address: listing.sellerAddress,
          amountSats: price,
          kind: "seller",
        },
      ];
      if (requiredProtocolFee > 0n) {
        expectedOutputs.push({
          index: 1,
          address: state.config.protocolFeeAddress,
          amountSats: requiredProtocolFee,
          kind: "protocol-fee",
        });
      }
      if (requiredPlatformFee > 0n) {
        expectedOutputs.push({
          index: expectedOutputs.length,
          address: state.config.treasuryAddress,
          amountSats: requiredPlatformFee,
          kind: "platform-fee",
        });
      }
      const layoutError = validateExactOutputs(tx.outputs, expectedOutputs);
      if (layoutError)
        return { valid: false, reason: layoutError, normalized: null };
      const walletBtc = state.balances[signer]?.btcSats ?? MOCK_FAUCET_SATS;
      const total =
        price + requiredProtocolFee + requiredPlatformFee + tx.feeSats;
      if (walletBtc < total)
        return { valid: false, reason: "INSUFFICIENT_BTC", normalized: null };
      return {
        valid: true,
        reason: null,
        normalized: {
          listingId: listing.id,
          deploymentId: listing.deploymentId,
          buyerAddress: signer,
          sellerAddress: listing.sellerAddress,
          tokenAmountAtoms: listing.tokenAmountAtoms,
          totalPriceSats: price,
          protocolFeeSats: requiredProtocolFee,
          platformFeeSats: requiredPlatformFee,
          minerFeeSats: tx.feeSats,
        },
      };
    }
    case "DEX_CANCEL": {
      const listing = state.listings[p.listingId ?? ""];
      if (!listing)
        return { valid: false, reason: "LISTING_NOT_FOUND", normalized: null };
      if (listing.status !== "OPEN")
        return {
          valid: false,
          reason: "LISTING_NOT_CANCELLABLE",
          normalized: null,
        };
      if (!signer || signer !== listing.sellerAddress)
        return { valid: false, reason: "NOT_LISTING_OWNER", normalized: null };
      if (tx.outputs.length !== 0)
        return {
          valid: false,
          reason: "INVALID_OUTPUT_LAYOUT",
          normalized: null,
        };
      return {
        valid: true,
        reason: null,
        normalized: {
          listingId: listing.id,
          sellerAddress: signer,
          tokenAmountAtoms: listing.tokenAmountAtoms,
          deploymentId: listing.deploymentId,
        },
      };
    }
    case "GRADUATION": {
      const token = state.tokens[p.deploymentId ?? ""];
      if (!token)
        return { valid: false, reason: "TOKEN_NOT_FOUND", normalized: null };
      if (token.confirmedMintedAtoms !== PUBLIC_SUPPLY_TOKENS) {
        return { valid: false, reason: "NOT_SOLD_OUT", normalized: null };
      }
      if (token.status !== "SOLD_OUT" && token.status !== "GRADUATING") {
        return { valid: false, reason: "NOT_GRADUATABLE", normalized: null };
      }
      return {
        valid: true,
        reason: null,
        normalized: {
          deploymentId: token.deploymentId,
          reserveSats: token.reserveSats,
        },
      };
    }
    default:
      return {
        valid: false,
        reason: "UNSUPPORTED_OPERATION",
        normalized: null,
      };
  }
}
function applyNormalized(
  state: MockChainState,
  tx: MockTx,
  n: any,
  blockHeight: bigint,
  blockHash: string,
): void {
  switch (tx.op) {
    case "DEPLOY": {
      const wallet = ensureWallet(state, n.creatorAddress);
      wallet.btcSats -= n.launchFeeSats + tx.feeSats;
      ensureWallet(state, state.config.treasuryAddress).btcSats +=
        n.launchFeeSats;
      state.platformTreasurySats += n.launchFeeSats;
      const token: MockToken = {
        deploymentId: tx.txid,
        ticker: n.ticker,
        tickerNormalized: n.tickerNormalized,
        name: n.name,
        creatorAddress: n.creatorAddress,
        network: state.network,
        totalSupplyAtoms: TOTAL_SUPPLY_TOKENS,
        publicSupplyAtoms: PUBLIC_SUPPLY_TOKENS,
        reserveSupplyAtoms: RESERVE_SUPPLY_TOKENS,
        confirmedMintedAtoms: 0n,
        pendingMintedAtoms: 0n,
        currentStage: 1,
        deployHeight: blockHeight,
        status: "LIVE",
        reserveSats: 0n,
        lastTradePricePerMillion: null,
      };
      state.tokens[tx.txid] = token;
      state.tickerIndex[n.tickerNormalized] = tx.txid;
      emitEvent(state, tx, blockHeight, blockHash, "DEPLOY", {
        deploymentId: tx.txid,
        walletFrom: n.creatorAddress,
        btcAmountSats: n.launchFeeSats,
        payload: { ticker: n.ticker, name: n.name },
      });
      return;
    }
    case "MINT": {
      const wallet = ensureWallet(state, n.buyerAddress);
      const total =
        n.curveContributionSats + n.platformFeeSats + n.minerFeeSats;
      wallet.btcSats -= total;
      wallet.tokens[n.deploymentId] =
        (wallet.tokens[n.deploymentId] ?? 0n) + n.tokenAmountAtoms;
      const token = state.tokens[n.deploymentId]!;
      token.reserveSats += n.curveContributionSats;
      ensureWallet(state, state.config.treasuryAddress).btcSats +=
        n.platformFeeSats;
      state.platformTreasurySats += n.platformFeeSats;
      token.confirmedMintedAtoms += n.tokenAmountAtoms;
      token.currentStage = getStageForSupply(token.confirmedMintedAtoms);
      if (token.confirmedMintedAtoms === PUBLIC_SUPPLY_TOKENS)
        token.status = "SOLD_OUT";
      emitEvent(state, tx, blockHeight, blockHash, "MINT", {
        deploymentId: n.deploymentId,
        walletFrom: n.buyerAddress,
        walletTo: n.buyerAddress,
        tokenAmountAtoms: n.tokenAmountAtoms,
        btcAmountSats: n.curveContributionSats,
        payload: {
          platformFeeSats: n.platformFeeSats,
          minerFeeSats: n.minerFeeSats,
        },
      });
      return;
    }
    case "TRANSFER": {
      const fromWallet = ensureWallet(state, n.from);
      fromWallet.tokens[n.deploymentId] =
        (fromWallet.tokens[n.deploymentId] ?? 0n) - n.tokenAmountAtoms;
      ensureWallet(state, n.to).tokens[n.deploymentId] =
        (ensureWallet(state, n.to).tokens[n.deploymentId] ?? 0n) +
        n.tokenAmountAtoms;
      emitEvent(state, tx, blockHeight, blockHash, "TRANSFER", {
        deploymentId: n.deploymentId,
        walletFrom: n.from,
        walletTo: n.to,
        tokenAmountAtoms: n.tokenAmountAtoms,
      });
      return;
    }
    case "DEX_ASK": {
      const wallet = ensureWallet(state, n.sellerAddress);
      wallet.lockedTokens[n.deploymentId] =
        (wallet.lockedTokens[n.deploymentId] ?? 0n) + n.tokenAmountAtoms;
      const listing: MockListing = {
        id: n.listingId,
        deploymentId: n.deploymentId,
        sellerAddress: n.sellerAddress,
        tokenAmountAtoms: n.tokenAmountAtoms,
        askingPriceSats: n.askingPriceSats,
        creationHeight: blockHeight,
        expiryHeight: n.expiryHeight,
        status: "OPEN",
      };
      state.listings[listing.id] = listing;
      emitEvent(state, tx, blockHeight, blockHash, "DEX_ASK", {
        deploymentId: n.deploymentId,
        walletFrom: n.sellerAddress,
        tokenAmountAtoms: n.tokenAmountAtoms,
        btcAmountSats: n.askingPriceSats,
        payload: { listingId: listing.id, expiryHeight: listing.expiryHeight },
      });
      return;
    }
    case "DEX_BID": {
      const wallet = ensureWallet(state, n.buyerAddress);
      const total =
        n.totalPriceSats +
        n.protocolFeeSats +
        n.platformFeeSats +
        n.minerFeeSats;
      wallet.btcSats -= total;
      ensureWallet(state, n.sellerAddress).btcSats += n.totalPriceSats;
      if (n.platformFeeSats > 0n) {
        ensureWallet(state, state.config.treasuryAddress).btcSats +=
          n.platformFeeSats;
        state.platformTreasurySats += n.platformFeeSats;
      }
      if (n.protocolFeeSats > 0n) {
        state.protocolTreasurySats += n.protocolFeeSats;
      }
      const sellerWallet = ensureWallet(state, n.sellerAddress);
      sellerWallet.tokens[n.deploymentId] =
        (sellerWallet.tokens[n.deploymentId] ?? 0n) - n.tokenAmountAtoms;
      sellerWallet.lockedTokens[n.deploymentId] =
        (sellerWallet.lockedTokens[n.deploymentId] ?? 0n) - n.tokenAmountAtoms;
      wallet.tokens[n.deploymentId] =
        (wallet.tokens[n.deploymentId] ?? 0n) + n.tokenAmountAtoms;
      state.listings[n.listingId]!.status = "TAKEN";
      const token = state.tokens[n.deploymentId];
      if (token) {
        token.lastTradePricePerMillion =
          (n.totalPriceSats * 1000000n) / n.tokenAmountAtoms;
      }
      emitEvent(state, tx, blockHeight, blockHash, "DEX_BID", {
        deploymentId: n.deploymentId,
        walletFrom: n.buyerAddress,
        walletTo: n.sellerAddress,
        tokenAmountAtoms: n.tokenAmountAtoms,
        btcAmountSats: n.totalPriceSats,
        payload: {
          listingId: n.listingId,
          protocolFeeSats: n.protocolFeeSats,
          platformFeeSats: n.platformFeeSats,
        },
      });
      return;
    }
    case "DEX_CANCEL": {
      const wallet = ensureWallet(state, n.sellerAddress);
      wallet.lockedTokens[n.deploymentId] =
        (wallet.lockedTokens[n.deploymentId] ?? 0n) - n.tokenAmountAtoms;
      state.listings[n.listingId]!.status = "CANCELLED";
      emitEvent(state, tx, blockHeight, blockHash, "DEX_CANCEL", {
        deploymentId: n.deploymentId,
        walletFrom: n.sellerAddress,
        tokenAmountAtoms: n.tokenAmountAtoms,
        payload: { listingId: n.listingId },
      });
      return;
    }
    case "GRADUATION": {
      state.tokens[n.deploymentId]!.status = "GRADUATED";
      emitEvent(state, tx, blockHeight, blockHash, "GRADUATION", {
        deploymentId: n.deploymentId,
        btcAmountSats: n.reserveSats,
        payload: { reserveSats: n.reserveSats },
      });
      return;
    }
  }
}
function applyTx(
  state: MockChainState,
  tx: MockTx,
  blockHeight: bigint,
  blockHash: string,
): "CONFIRMED" | "REJECTED" {
  const v = validateTx(state, tx, blockHeight);
  if (!v.valid) {
    tx.status = "REJECTED";
    tx.confirmHeight = null;
    tx.rejectReason = v.reason;
    return "REJECTED";
  }
  applyNormalized(state, tx, v.normalized, blockHeight, blockHash);
  tx.status = "CONFIRMED";
  tx.confirmHeight = blockHeight;
  tx.rejectReason = null;
  return "CONFIRMED";
}
export function rebuildDerivedState(state: MockChainState): void {
  state.tokens = {};
  state.tickerIndex = {};
  state.balances = {};
  state.listings = {};
  state.platformTreasurySats = 0n;
  state.protocolTreasurySats = 0n;
  for (const block of state.blocks) {
    for (const txid of block.txids) {
      const tx = state.txs[txid];
      if (tx) {
        const v = validateTx(state, tx, block.height);
        if (v.valid) {
          tx.status = "CONFIRMED";
          tx.confirmHeight = block.height;
          tx.rejectReason = null;
          applyNormalized(state, tx, v.normalized, block.height, block.hash);
        } else {
          tx.status = "REJECTED";
          tx.rejectReason = v.reason;
        }
      }
    }
  }
}
export function reorg(state: MockChainState, depth: number): MockBlock[] {
  if (depth <= 0) return [];
  const removed = state.blocks.splice(-depth, depth);
  for (const block of removed) {
    for (const txid of block.txids) {
      const tx = state.txs[txid];
      if (tx) {
        tx.status = "MEMPOOL";
        tx.confirmHeight = null;
        tx.rejectReason = null;
        state.mempool.push(txid);
      }
      const ev = state.events[`${txid}:0`];
      if (ev) ev.canonical = false;
    }
  }
  state.height -= BigInt(removed.length);
  rebuildDerivedState(state);
  return removed;
}
export function getConfirmedEvents(state: MockChainState): MockEvent[] {
  return Object.values(state.events)
    .filter((e) => e.canonical)
    .sort((a, b) =>
      a.blockHeight < b.blockHeight
        ? -1
        : a.blockHeight > b.blockHeight
          ? 1
          : 0,
    );
}
export function getEventsInRange(
  state: MockChainState,
  from: bigint,
  to: bigint,
): MockEvent[] {
  return getConfirmedEvents(state).filter(
    (e) => e.blockHeight >= from && e.blockHeight <= to,
  );
}
export function assertProtocolInvariants(state: MockChainState): string[] {
  const problems: string[] = [];
  for (const t of Object.values(state.tokens)) {
    if (
      t.confirmedMintedAtoms < 0n ||
      t.confirmedMintedAtoms > t.publicSupplyAtoms
    ) {
      problems.push(`${t.ticker}: confirmed minted out of range`);
    }
    if (
      t.status === "SOLD_OUT" &&
      t.confirmedMintedAtoms !== t.publicSupplyAtoms
    ) {
      problems.push(`${t.ticker}: SOLD_OUT but not fully minted`);
    }
    if (
      t.status === "GRADUATED" &&
      t.confirmedMintedAtoms !== t.publicSupplyAtoms
    ) {
      problems.push(`${t.ticker}: GRADUATED but not fully minted`);
    }
    if (t.reserveSats < 0n) problems.push(`${t.ticker}: negative reserve`);
  }
  for (const [address, b] of Object.entries(state.balances)) {
    for (const [dep, amt] of Object.entries(b.tokens)) {
      if (amt < 0n) problems.push(`${address}: negative balance for ${dep}`);
    }
    for (const [dep, amt] of Object.entries(b.lockedTokens)) {
      if (amt < 0n) problems.push(`${address}: negative locked for ${dep}`);
      if (amt > (b.tokens[dep] ?? 0n))
        problems.push(`${address}: locked exceeds balance for ${dep}`);
    }
  }
  const openLocks: Record<string, bigint> = {};
  for (const l of Object.values(state.listings)) {
    if (l.status === "OPEN") {
      const key = `${l.sellerAddress}:${l.deploymentId}`;
      openLocks[key] = (openLocks[key] ?? 0n) + l.tokenAmountAtoms;
    }
    if (
      l.status !== "OPEN" &&
      l.status !== "TAKEN" &&
      l.status !== "CANCELLED" &&
      l.status !== "EXPIRED"
    ) {
      problems.push(`listing ${l.id}: bad status ${l.status}`);
    }
  }
  for (const [key, required] of Object.entries(openLocks)) {
    const [address, dep] = key.split(":");
    const locked = state.balances[address!]?.lockedTokens[dep!] ?? 0n;
    if (locked < required) {
      problems.push(
        `${address}: locked ${locked} < open listings sum ${required} for ${dep}`,
      );
    }
  }
  for (const [ticker, dep] of Object.entries(state.tickerIndex)) {
    const t = state.tokens[dep];
    if (!t) problems.push(`tickerIndex ${ticker} → missing token`);
    else if (t.tickerNormalized !== ticker)
      problems.push(`tickerIndex ${ticker} → wrong token`);
  }
  const mintedSum: Record<string, bigint> = {};
  for (const b of Object.values(state.balances)) {
    for (const [dep, amt] of Object.entries(b.tokens)) {
      mintedSum[dep] = (mintedSum[dep] ?? 0n) + amt;
    }
  }
  for (const [dep, t] of Object.entries(state.tokens)) {
    if ((mintedSum[dep] ?? 0n) !== t.confirmedMintedAtoms) {
      problems.push(
        `${t.ticker}: balance sum ${mintedSum[dep]} != confirmed ${t.confirmedMintedAtoms}`,
      );
    }
  }
  return problems;
}
