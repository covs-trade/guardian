import {
  STAGE_COUNT,
  STAGE_PRICES_SATS_PER_MILLION,
  TOTAL_SUPPLY_TOKENS,
  CREATOR_PREMINE_TOKENS,
  getStageForSupply,
  quoteExactTokens,
  getMinimumContribution,
  getRemainingPublicSupply,
} from "@crclaunch/curve";
import { ProtocolError } from "./errors.js";
import type {
  CanonicalActivityPage,
  CanonicalCRCProvider,
  CanonicalTokenState,
  CRCCapabilities,
  CRCOperationStatus,
  CRCSubmissionResult,
  DeploymentAuthorization,
  DeploymentRules,
  MintAuthorization,
  MintRules,
  SignedCRCOperation,
  TickerValidation,
} from "./canonical.js";
import type { MockCRCAdapter } from "./mock/adapter.js";
import type { MockChainNode } from "./mock/node.js";
import { toProtocolToken } from "./mock/adapter.js";
const DECIMALS = 8;
const ONE_TOKEN = 10n ** BigInt(DECIMALS);
const TOTAL_ATOMS_8DP = TOTAL_SUPPLY_TOKENS * ONE_TOKEN;
export function crcLaunchV1DeploymentRules(): DeploymentRules {
  return {
    profile: "crc-launch-v1",
    maxSupplyAtoms: TOTAL_ATOMS_8DP,
    decimals: DECIMALS,
    publicBps: 8400,
    reserveBps: 1600,
    stageCount: STAGE_COUNT,
    priceTableSatsPerMillion: STAGE_PRICES_SATS_PER_MILLION,
    creatorPremineAtoms: CREATOR_PREMINE_TOKENS * ONE_TOKEN,
  };
}
const FULL_CAPABILITIES: CRCCapabilities = {
  arbitraryDeploy: true,
  progressiveMint: true,
  customSupply: false,
  oracleAuthorization: true,
  canonicalBalanceQuery: true,
  transfer: true,
  marketplace: true,
  graduation: true,
  vault: true,
};
export class MockCanonicalCRCProvider implements CanonicalCRCProvider {
  constructor(
    private readonly adapter: MockCRCAdapter,
    private readonly node: MockChainNode,
  ) {}
  async getCapabilities(): Promise<CRCCapabilities> {
    return { ...FULL_CAPABILITIES };
  }
  async validateTicker(ticker: string): Promise<TickerValidation> {
    const norm = ticker.toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(norm)) {
      return {
        ticker: norm,
        valid: false,
        reason: "Ticker must be exactly 4 uppercase A-Z/0-9.",
      };
    }
    const existing = await this.adapter.getTokenByTicker(norm);
    if (existing)
      return {
        ticker: norm,
        valid: false,
        reason: `Ticker ${norm} is already taken.`,
      };
    return { ticker: norm, valid: true };
  }
  async requestDeploymentAuthorization(params: {
    ticker: string;
    name: string;
    profile?: string;
    creatorAddress: string;
  }): Promise<DeploymentAuthorization> {
    const v = await this.validateTicker(params.ticker);
    if (!v.valid) return { authorized: false, reason: v.reason };
    return {
      authorized: true,
      expiresAt: new Date(Date.now() + 120000).toISOString(),
    };
  }
  async getDeploymentRules(): Promise<DeploymentRules> {
    return crcLaunchV1DeploymentRules();
  }
  async getMintRules(deploymentId: string): Promise<MintRules> {
    const token = await this.adapter.getTokenByDeployment(deploymentId);
    if (!token)
      throw new ProtocolError("PROTOCOL_UNAVAILABLE", "Token not found.");
    return {
      deploymentId,
      profile: "crc-launch-v1",
      stageCount: STAGE_COUNT,
      priceTableSatsPerMillion: STAGE_PRICES_SATS_PER_MILLION,
      remainingPublicSupplyAtoms:
        getRemainingPublicSupply(token.confirmedMintedAtoms) * ONE_TOKEN,
      minimumContributionSats: getMinimumContribution(500n),
    };
  }
  async requestMintAuthorization(request: {
    deploymentId: string;
    walletAddress: string;
    requestedAmountAtoms: bigint;
  }): Promise<MintAuthorization> {
    const token = await this.adapter.getTokenByDeployment(request.deploymentId);
    if (!token)
      throw new ProtocolError("PROTOCOL_UNAVAILABLE", "Token not found.");
    if (token.status !== "LIVE") {
      return {
        authorized: false,
        reason: "Public mint is not live.",
        ...emptyQuote(request),
      };
    }
    const tokenUnits = request.requestedAmountAtoms / ONE_TOKEN;
    let quote;
    try {
      quote = quoteExactTokens({
        desiredTokens: tokenUnits,
        currentSupply: token.confirmedMintedAtoms,
      });
    } catch (e) {
      return {
        authorized: false,
        reason: e instanceof Error ? e.message : "Invalid amount.",
        ...emptyQuote(request),
      };
    }
    const requiredPayment = quote.curveContributionSats;
    return {
      authorized: true,
      requiredPaymentSats: requiredPayment,
      tokenAmountAtoms: request.requestedAmountAtoms,
      startingStage: quote.startingStage,
      endingStage: quote.endingStage,
      supplyBeforeAtoms: quote.supplyBefore * ONE_TOKEN,
      supplyAfterAtoms: quote.supplyAfter * ONE_TOKEN,
      authorizationId: `mock-mint-auth-${Date.now()}`,
      expiresAt: new Date(Date.now() + 120000).toISOString(),
    };
  }
  async submitSignedOperation(
    operation: SignedCRCOperation,
  ): Promise<CRCSubmissionResult> {
    const txid = await this.adapter.broadcast(operation.signedTransactionHex);
    return { operationId: txid, status: "submitted" };
  }
  async getOperationStatus(operationId: string): Promise<CRCOperationStatus> {
    const tx = await this.node.getMockTx(operationId);
    if (!tx) return { operationId, status: "pending" };
    return {
      operationId,
      status:
        tx.status === "CONFIRMED"
          ? "finalized"
          : tx.status === "REJECTED"
            ? "rejected"
            : "accepted",
      txid: tx.txid,
      blockHeight: tx.confirmHeight ?? undefined,
      reason: tx.rejectReason ?? undefined,
    };
  }
  async getCanonicalState(deploymentId: string): Promise<CanonicalTokenState> {
    const mt = await this.node.getTokenByDeployment(deploymentId);
    if (!mt)
      throw new ProtocolError("PROTOCOL_UNAVAILABLE", "Token not found.");
    const t = toProtocolToken(mt);
    return {
      deploymentId: t.deploymentId,
      ticker: t.ticker,
      status: t.status,
      totalSupplyAtoms: t.totalSupplyAtoms * ONE_TOKEN,
      confirmedMintedAtoms: t.confirmedMintedAtoms * ONE_TOKEN,
      remainingPublicSupplyAtoms:
        getRemainingPublicSupply(t.confirmedMintedAtoms) * ONE_TOKEN,
      currentStage: getStageForSupply(t.confirmedMintedAtoms),
      reserveSats: mt.reserveSats,
      stateHash: await this.node.getStateHash(),
    };
  }
  async getCanonicalActivity(_cursor?: string): Promise<CanonicalActivityPage> {
    const height = await this.node.getHeight();
    const events = await this.node.getEvents(0n, height);
    return {
      items: events.map((e) => ({
        txid: e.txid,
        blockHeight: e.blockHeight,
        type: e.eventType,
        amountAtoms: e.tokenAmountAtoms
          ? e.tokenAmountAtoms * ONE_TOKEN
          : undefined,
        btcSats: e.btcAmountSats ?? undefined,
        timestamp: new Date().toISOString(),
      })),
      nextCursor: null,
    };
  }
}
function emptyQuote(request: {
  requestedAmountAtoms: bigint;
}): Omit<MintAuthorization, "authorized" | "reason"> {
  return {
    requiredPaymentSats: 0n,
    tokenAmountAtoms: request.requestedAmountAtoms,
    startingStage: 0,
    endingStage: 0,
    supplyBeforeAtoms: 0n,
    supplyAfterAtoms: 0n,
  };
}
export class UnavailableCanonicalCRCProvider implements CanonicalCRCProvider {
  async getCapabilities(): Promise<CRCCapabilities> {
    return {
      arbitraryDeploy: false,
      progressiveMint: false,
      customSupply: false,
      oracleAuthorization: false,
      canonicalBalanceQuery: false,
      transfer: false,
      marketplace: false,
      graduation: false,
      vault: false,
    };
  }
  async validateTicker(): Promise<TickerValidation> {
    throw new ProtocolError(
      "PROTOCOL_NOT_VERIFIED",
      "Canonical CRC integration is not available.",
    );
  }
  async requestDeploymentAuthorization(): Promise<DeploymentAuthorization> {
    throw new ProtocolError(
      "PROTOCOL_NOT_VERIFIED",
      "Canonical CRC integration is not available.",
    );
  }
  async getDeploymentRules(): Promise<DeploymentRules> {
    throw new ProtocolError(
      "PROTOCOL_NOT_VERIFIED",
      "Canonical CRC integration is not available.",
    );
  }
  async getMintRules(): Promise<MintRules> {
    throw new ProtocolError(
      "PROTOCOL_NOT_VERIFIED",
      "Canonical CRC integration is not available.",
    );
  }
  async requestMintAuthorization(): Promise<MintAuthorization> {
    throw new ProtocolError(
      "PROTOCOL_NOT_VERIFIED",
      "Canonical CRC integration is not available.",
    );
  }
  async submitSignedOperation(): Promise<CRCSubmissionResult> {
    throw new ProtocolError(
      "PROTOCOL_NOT_VERIFIED",
      "Canonical CRC integration is not available.",
    );
  }
  async getOperationStatus(operationId: string): Promise<CRCOperationStatus> {
    return { operationId, status: "pending" };
  }
  async getCanonicalState(_deploymentId: string): Promise<CanonicalTokenState> {
    throw new ProtocolError(
      "PROTOCOL_NOT_VERIFIED",
      "Canonical CRC integration is not available.",
    );
  }
  async getCanonicalActivity(): Promise<CanonicalActivityPage> {
    return { items: [], nextCursor: null };
  }
}
