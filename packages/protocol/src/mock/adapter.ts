import type { ProtocolHealth } from "@crclaunch/config";
import type { Sats } from "@crclaunch/curve";
import type {
  BuildBuyInput,
  BuildCancelInput,
  BuildDeployInput,
  BuildMintInput,
  BuildSellInput,
  DecodedProtocolTransaction,
  DecodedSignedTransaction,
  ProtocolEvent,
  ProtocolToken,
  ProtocolTransactionStatus,
  TransactionOutput,
  UnsignedProtocolTransaction,
  ValidationResult,
  VerificationStatus,
} from "../types.js";
import { ProtocolError } from "../errors.js";
import { MOCK_VERIFICATION } from "../verification.js";
import type { MockChainNode } from "./node.js";
import {
  buildEnvelope,
  envelopeToPsbt,
  parseSignedMockPsbt,
} from "./envelope.js";
import type {
  MockEvent,
  MockListing,
  MockToken,
  MockTxEnvelope,
} from "./types.js";
import {
  MOCK_RESERVE_ADDRESS,
  MOCK_PROTOCOL_FEE_ADDRESS,
} from "../validation/config.js";
export {
  MOCK_RESERVE_ADDRESS,
  MOCK_PROTOCOL_FEE_ADDRESS as MOCK_PROTOCOL_TREASURY,
};
function mockMinerFee(inputs: number, outputs: number): Sats {
  return BigInt(150 * inputs + 150 * outputs);
}
export function toProtocolToken(mt: MockToken): ProtocolToken {
  return {
    deploymentId: mt.deploymentId,
    ticker: mt.ticker,
    tickerNormalized: mt.tickerNormalized,
    name: mt.name,
    creatorAddress: mt.creatorAddress,
    network: mt.network,
    totalSupplyAtoms: mt.totalSupplyAtoms,
    publicSupplyAtoms: mt.publicSupplyAtoms,
    reserveSupplyAtoms: mt.reserveSupplyAtoms,
    confirmedMintedAtoms: mt.confirmedMintedAtoms,
    pendingMintedAtoms: mt.pendingMintedAtoms,
    currentStage: mt.currentStage,
    deployHeight: mt.deployHeight,
    status: mt.status,
    stateHash: "",
  };
}
export function toProtocolEvent(e: MockEvent): ProtocolEvent {
  return {
    network: e.network,
    blockHeight: e.blockHeight,
    blockHash: e.blockHash,
    txid: e.txid,
    eventIndex: e.eventIndex,
    eventType: e.eventType,
    deploymentId: e.deploymentId,
    walletFrom: e.walletFrom,
    walletTo: e.walletTo,
    tokenAmountAtoms: e.tokenAmountAtoms,
    btcAmountSats: e.btcAmountSats,
    payload: e.payload,
  };
}
export function toProtocolTxStatus(
  txid: string,
  mt: {
    status: string;
    confirmHeight: bigint | null;
  },
  height: bigint,
): ProtocolTransactionStatus {
  const confirmations =
    mt.confirmHeight !== null ? Number(height - mt.confirmHeight + 1n) : 0;
  return {
    txid,
    status:
      mt.status === "CONFIRMED"
        ? "CONFIRMED"
        : mt.status === "MEMPOOL"
          ? "MEMPOOL"
          : mt.status === "REJECTED"
            ? "REJECTED"
            : "UNKNOWN",
    confirmations,
    blockHeight: mt.confirmHeight,
  };
}
export class MockCRCAdapter {
  readonly id = "mock";
  private readonly node: MockChainNode;
  constructor(node: MockChainNode) {
    this.node = node;
  }
  getVerificationStatus(): VerificationStatus {
    return MOCK_VERIFICATION;
  }
  async getHealth(): Promise<ProtocolHealth> {
    const h = await this.node.getHealth();
    return {
      state: "HEALTHY",
      synced: h.synced,
      stateValid: h.stateValid,
      lagBlocks: h.lagBlocks,
    };
  }
  async getCurrentHeight(): Promise<bigint> {
    return this.node.getHeight();
  }
  async getStateHash(): Promise<string> {
    return this.node.getStateHash();
  }
  async getTokenByTicker(ticker: string): Promise<ProtocolToken | null> {
    const mt = await this.node.getTokenByTicker(ticker);
    return mt ? toProtocolToken(mt) : null;
  }
  async getTokenByDeployment(txid: string): Promise<ProtocolToken | null> {
    const mt = await this.node.getTokenByDeployment(txid);
    return mt ? toProtocolToken(mt) : null;
  }
  async getAllTokens(): Promise<ProtocolToken[]> {
    return (await this.node.getAllTokens()).map(toProtocolToken);
  }
  async getListings(): Promise<MockListing[]> {
    return this.node.getListings();
  }
  async getListing(id: string): Promise<MockListing | null> {
    return this.node.getListing(id);
  }
  async buildDeploy(
    input: BuildDeployInput,
  ): Promise<UnsignedProtocolTransaction> {
    const existing = await this.node.getTokenByTicker(input.ticker);
    if (existing) {
      throw new ProtocolError(
        "TICKER_TAKEN",
        `Ticker ${input.ticker} is already taken.`,
      );
    }
    const fee = mockMinerFee(1, 1);
    const outputs: TransactionOutput[] = [
      {
        index: 0,
        address: this.node.snapshot.config.treasuryAddress,
        amountSats: input.launchFeeSats,
        kind: "launch-fee",
      },
    ];
    const payload = {
      ticker: input.ticker,
      name: input.name,
      creatorAddress: input.creatorAddress,
      treasuryAddress: this.node.snapshot.config.treasuryAddress,
      launchFeeSats: input.launchFeeSats,
    };
    const envelope = buildEnvelope({
      op: "DEPLOY",
      network: input.network,
      payload,
      inputs: [
        {
          txid: `mock-utxo-${input.creatorAddress}`,
          vout: 0,
          address: input.creatorAddress,
          amountSats: input.launchFeeSats + fee,
        },
      ],
      outputs,
      feeSats: fee,
      stateHash: await this.node.getStateHash(),
      expiresAtHeight: (await this.node.getHeight()) + 2n,
      expiresAtTimestamp: new Date(Date.now() + 120000).toISOString(),
    });
    return this.toUnsigned(envelope, {
      summary: {
        operation: "DEPLOY",
        ticker: input.ticker,
        launchFeeSats: input.launchFeeSats,
        minerFeeSats: fee,
        totalSpendSats: input.launchFeeSats + fee,
        outputCount: outputs.length,
      },
    });
  }
  async buildMint(input: BuildMintInput): Promise<UnsignedProtocolTransaction> {
    const token = await this.node.getTokenByDeployment(input.deploymentId);
    if (!token)
      throw new ProtocolError("PROTOCOL_UNAVAILABLE", "Token not found.");
    const stateHash = await this.node.getStateHash();
    if (input.stateHash !== stateHash) {
      throw new ProtocolError(
        "QUOTE_EXPIRED",
        "Protocol state hash changed; request a new quote.",
      );
    }
    if (token.confirmedMintedAtoms !== input.currentSupplyAtoms) {
      throw new ProtocolError(
        "SUPPLY_CHANGED",
        "Minted supply changed; refresh your quote.",
      );
    }
    if (token.status !== "LIVE") {
      throw new ProtocolError("MINT_SOLD_OUT", "Public mint is not live.");
    }
    const outputs: TransactionOutput[] = [
      {
        index: 0,
        address: this.node.snapshot.config.reserveAddress,
        amountSats: input.curveContributionSats,
        kind: "curve-reserve",
      },
      {
        index: 1,
        address: this.node.snapshot.config.treasuryAddress,
        amountSats: input.platformFeeSats,
        kind: "platform-fee",
      },
    ];
    const payload = {
      deploymentId: input.deploymentId,
      ticker: input.ticker,
      buyerAddress: input.buyerAddress,
      treasuryAddress: this.node.snapshot.config.treasuryAddress,
      tokenAmountAtoms: input.tokenAmountAtoms,
      curveContributionSats: input.curveContributionSats,
      platformFeeSats: input.platformFeeSats,
      minerFeeSats: input.minerFeeSats,
      supplyBeforeAtoms: input.currentSupplyAtoms,
    };
    const envelope = buildEnvelope({
      op: "MINT",
      network: token.network,
      payload,
      inputs: [
        {
          txid: `mock-utxo-${input.buyerAddress}`,
          vout: 0,
          address: input.buyerAddress,
          amountSats:
            input.curveContributionSats +
            input.platformFeeSats +
            input.minerFeeSats,
        },
      ],
      outputs,
      feeSats: input.minerFeeSats,
      stateHash,
      expiresAtHeight: (await this.node.getHeight()) + 2n,
      expiresAtTimestamp: new Date(Date.now() + 120000).toISOString(),
    });
    return this.toUnsigned(envelope, {
      summary: {
        operation: "MINT",
        ticker: input.ticker,
        tokenAmountAtoms: input.tokenAmountAtoms,
        curveContributionSats: input.curveContributionSats,
        platformFeeSats: input.platformFeeSats,
        minerFeeSats: input.minerFeeSats,
        totalSpendSats:
          input.curveContributionSats +
          input.platformFeeSats +
          input.minerFeeSats,
        outputCount: outputs.length,
      },
    });
  }
  async buildSellListing(
    input: BuildSellInput,
  ): Promise<UnsignedProtocolTransaction> {
    const token = await this.node.getTokenByDeployment(input.deploymentId);
    if (!token)
      throw new ProtocolError("PROTOCOL_UNAVAILABLE", "Token not found.");
    if (token.status !== "GRADUATED") {
      throw new ProtocolError(
        "UNSUPPORTED_OPERATION",
        "Only graduated tokens can be listed.",
      );
    }
    const bal = await this.node.getWalletBalance(input.sellerAddress);
    const available =
      (bal.tokens[input.deploymentId] ?? 0n) -
      (bal.lockedTokens[input.deploymentId] ?? 0n);
    if (available < input.tokenAmountAtoms) {
      throw new ProtocolError(
        "INSUFFICIENT_BTC",
        "Insufficient token balance to list.",
      );
    }
    const fee = mockMinerFee(1, 1);
    const outputs: TransactionOutput[] = [];
    const envelope = buildEnvelope({
      op: "DEX_ASK",
      network: token.network,
      payload: {
        deploymentId: input.deploymentId,
        sellerAddress: input.sellerAddress,
        tokenAmountAtoms: input.tokenAmountAtoms,
        askingPriceSats: input.askingPriceSats,
        expiryHeight: input.expiryHeight,
        listingId: "",
      },
      inputs: [
        {
          txid: `mock-token-utxo-${input.sellerAddress}`,
          vout: 0,
          address: input.sellerAddress,
          amountSats: 0n,
        },
      ],
      outputs,
      feeSats: fee,
      stateHash: await this.node.getStateHash(),
      expiresAtHeight: (await this.node.getHeight()) + 2n,
      expiresAtTimestamp: new Date(Date.now() + 120000).toISOString(),
    });
    return this.toUnsigned(envelope, {
      summary: {
        operation: "DEX_ASK",
        ticker: token.ticker,
        tokenAmountAtoms: input.tokenAmountAtoms,
        minerFeeSats: fee,
        sellerReceivesSats: input.askingPriceSats,
        outputCount: outputs.length,
      },
    });
  }
  async buildBuySettlement(
    input: BuildBuyInput,
  ): Promise<UnsignedProtocolTransaction> {
    const listing = await this.node.getListing(input.listingId);
    if (!listing)
      throw new ProtocolError("LISTING_ALREADY_TAKEN", "Listing not found.");
    if (listing.status !== "OPEN") {
      throw new ProtocolError(
        "LISTING_ALREADY_TAKEN",
        "Listing is no longer available.",
      );
    }
    const fee = input.minerFeeSats;
    const outputs: TransactionOutput[] = [
      {
        index: 0,
        address: input.sellerAddress,
        amountSats: input.totalPriceSats,
        kind: "seller",
      },
    ];
    if (input.protocolFeeSats > 0n) {
      outputs.push({
        index: 1,
        address: this.node.snapshot.config.protocolFeeAddress,
        amountSats: input.protocolFeeSats,
        kind: "protocol-fee",
      });
    }
    if (input.platformFeeSats > 0n) {
      outputs.push({
        index: outputs.length,
        address: this.node.snapshot.config.treasuryAddress,
        amountSats: input.platformFeeSats,
        kind: "platform-fee",
      });
    }
    const token = await this.node.getTokenByDeployment(input.deploymentId);
    const envelope = buildEnvelope({
      op: "DEX_BID",
      network: token?.network ?? "mock",
      payload: {
        deploymentId: input.deploymentId,
        listingId: input.listingId,
        buyerAddress: input.buyerAddress,
        sellerAddress: input.sellerAddress,
        tokenAmountAtoms: input.tokenAmountAtoms,
        totalPriceSats: input.totalPriceSats,
        protocolFeeSats: input.protocolFeeSats,
        platformFeeSats: input.platformFeeSats,
        minerFeeSats: input.minerFeeSats,
        treasuryAddress: this.node.snapshot.config.treasuryAddress,
      },
      inputs: [
        {
          txid: `mock-utxo-${input.buyerAddress}`,
          vout: 0,
          address: input.buyerAddress,
          amountSats:
            input.totalPriceSats +
            input.protocolFeeSats +
            input.platformFeeSats +
            fee,
        },
      ],
      outputs,
      feeSats: fee,
      stateHash: await this.node.getStateHash(),
      expiresAtHeight: (await this.node.getHeight()) + 2n,
      expiresAtTimestamp: new Date(Date.now() + 120000).toISOString(),
    });
    return this.toUnsigned(envelope, {
      summary: {
        operation: "DEX_BID",
        ticker: token?.ticker,
        tokenAmountAtoms: input.tokenAmountAtoms,
        protocolFeeSats: input.protocolFeeSats,
        platformFeeSats: input.platformFeeSats,
        minerFeeSats: fee,
        sellerReceivesSats: input.totalPriceSats,
        buyerReceivesAtoms: input.tokenAmountAtoms,
        totalSpendSats:
          input.totalPriceSats +
          input.protocolFeeSats +
          input.platformFeeSats +
          fee,
        outputCount: outputs.length,
      },
    });
  }
  async buildCancelListing(
    input: BuildCancelInput,
  ): Promise<UnsignedProtocolTransaction> {
    const listing = await this.node.getListing(input.listingId);
    if (!listing)
      throw new ProtocolError("LISTING_ALREADY_TAKEN", "Listing not found.");
    if (listing.sellerAddress !== input.sellerAddress) {
      throw new ProtocolError(
        "UNSUPPORTED_OPERATION",
        "Not the listing owner.",
      );
    }
    const fee = mockMinerFee(1, 1);
    const envelope = buildEnvelope({
      op: "DEX_CANCEL",
      network: "mock",
      payload: {
        deploymentId: input.deploymentId,
        listingId: input.listingId,
        sellerAddress: input.sellerAddress,
      },
      inputs: [
        {
          txid: `mock-utxo-${input.sellerAddress}`,
          vout: 0,
          address: input.sellerAddress,
          amountSats: fee,
        },
      ],
      outputs: [],
      feeSats: fee,
      stateHash: await this.node.getStateHash(),
      expiresAtHeight: (await this.node.getHeight()) + 2n,
      expiresAtTimestamp: new Date(Date.now() + 120000).toISOString(),
    });
    return this.toUnsigned(envelope, {
      summary: {
        operation: "DEX_CANCEL",
        minerFeeSats: fee,
        totalSpendSats: fee,
        outputCount: 0,
      },
    });
  }
  async graduate(deploymentId: string): Promise<string> {
    const token = await this.node.getTokenByDeployment(deploymentId);
    if (!token)
      throw new ProtocolError("PROTOCOL_UNAVAILABLE", "Token not found.");
    const envelope = buildEnvelope({
      op: "GRADUATION",
      network: token.network,
      payload: { deploymentId },
      inputs: [],
      outputs: [],
      feeSats: 0n,
      stateHash: await this.node.getStateHash(),
      expiresAtHeight: (await this.node.getHeight()) + 2n,
      expiresAtTimestamp: new Date(Date.now() + 120000).toISOString(),
    });
    return this.node.mutate((state) => {
      const tx = {
        ...envelope,
        signer: null,
        signature: null,
        status: "MEMPOOL" as const,
        confirmHeight: null,
        rejectReason: null,
      };
      state.txs[envelope.txid] = tx;
      state.mempool.push(envelope.txid);
      return envelope.txid;
    });
  }
  async validateDeploy(
    tx: UnsignedProtocolTransaction,
  ): Promise<ValidationResult> {
    return this.validateOutputs(tx, (t) => [
      {
        address: t.outputs[0]?.address ?? null,
        amountSats: t.outputs[0]?.amountSats ?? -1n,
        kind: "launch-fee",
      },
    ]);
  }
  async validateMint(
    tx: UnsignedProtocolTransaction,
  ): Promise<ValidationResult> {
    return this.validateOutputs(tx, (t) => [
      {
        address: this.node.snapshot.config.reserveAddress,
        amountSats: t.summary.curveContributionSats ?? 0n,
        kind: "curve-reserve",
      },
      {
        address: t.outputs[1]?.address ?? null,
        amountSats: t.summary.platformFeeSats ?? 0n,
        kind: "platform-fee",
      },
    ]);
  }
  async validateSellListing(
    tx: UnsignedProtocolTransaction,
  ): Promise<ValidationResult> {
    const out = tx.outputs[0];
    const errors: string[] = [];
    if (!out || out.kind !== "token")
      errors.push("Expected a token-lock output.");
    return { valid: errors.length === 0, errors, warnings: [] };
  }
  async validateBuySettlement(
    tx: UnsignedProtocolTransaction,
  ): Promise<ValidationResult> {
    const out = tx.outputs[0];
    const errors: string[] = [];
    if (!out || out.kind !== "seller")
      errors.push("Expected a seller payment output.");
    return { valid: errors.length === 0, errors, warnings: [] };
  }
  async validateCancelListing(
    _tx: UnsignedProtocolTransaction,
  ): Promise<ValidationResult> {
    return { valid: true, errors: [], warnings: [] };
  }
  private validateOutputs(
    tx: UnsignedProtocolTransaction,
    expect: (t: UnsignedProtocolTransaction) => {
      address: string | null;
      amountSats: Sats;
      kind: string;
    }[],
  ): ValidationResult {
    const expected = expect(tx);
    const errors: string[] = [];
    if (tx.outputs.length !== expected.length) {
      errors.push(
        `Expected ${expected.length} outputs, got ${tx.outputs.length}.`,
      );
    }
    expected.forEach((e, i) => {
      const actual = tx.outputs[i];
      if (!actual) return;
      if (e.kind !== actual.kind)
        errors.push(
          `Output ${i}: expected kind ${e.kind}, got ${actual.kind}.`,
        );
      if (e.amountSats >= 0n && e.amountSats !== actual.amountSats) {
        errors.push(
          `Output ${i}: expected ${e.amountSats} sats, got ${actual.amountSats} sats.`,
        );
      }
      if (e.address && actual.address !== e.address) {
        errors.push(`Output ${i}: unexpected address ${actual.address}.`);
      }
    });
    return { valid: errors.length === 0, errors, warnings: [] };
  }
  async broadcast(signedTxHex: string): Promise<string> {
    return this.node.submitRawTx(signedTxHex);
  }
  async getTransaction(txid: string): Promise<ProtocolTransactionStatus> {
    const tx = await this.node.getMockTx(txid);
    if (!tx)
      return { txid, status: "UNKNOWN", confirmations: 0, blockHeight: null };
    const height = await this.node.getHeight();
    return toProtocolTxStatus(txid, tx, height);
  }
  async getEvents(
    fromHeight: bigint,
    toHeight: bigint,
  ): Promise<ProtocolEvent[]> {
    return (await this.node.getEvents(fromHeight, toHeight)).map(
      toProtocolEvent,
    );
  }
  async decodeTransaction(rawTx: string): Promise<DecodedProtocolTransaction> {
    const { envelope } = parseSignedMockPsbt(rawTx);
    return {
      operation: envelope.op,
      inputs: envelope.inputs,
      outputs: envelope.outputs,
      ticker: envelope.payload.ticker,
      tokenAmountAtoms: envelope.payload.tokenAmountAtoms,
    };
  }
  async decodeSignedTransaction(
    rawTx: string,
  ): Promise<DecodedSignedTransaction> {
    const { envelope, signer } = parseSignedMockPsbt(rawTx);
    return {
      operation: envelope.op,
      txid: envelope.txid,
      signer: signer || null,
    };
  }
  private toUnsigned(
    envelope: MockTxEnvelope,
    extra: {
      summary: UnsignedProtocolTransaction["summary"];
    },
  ): UnsignedProtocolTransaction {
    return {
      operation: envelope.op,
      network: envelope.network,
      txHex: null,
      psbtBase64: envelopeToPsbt(envelope),
      inputs: envelope.inputs,
      outputs: envelope.outputs,
      feeSats: envelope.feeSats,
      stateHash: envelope.stateHash,
      expiresAtHeight: envelope.expiresAtHeight,
      expiresAtTimestamp: envelope.expiresAtTimestamp,
      summary: extra.summary,
    };
  }
}
