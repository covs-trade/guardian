import type { ProtocolHealth } from "@crclaunch/config";
import type {
  DecodedProtocolTransaction,
  DecodedSignedTransaction,
  ProtocolEvent,
  ProtocolListing,
  ProtocolToken,
  ProtocolTransactionStatus,
  UnsignedProtocolTransaction,
  ValidationResult,
  VerificationStatus,
} from "./types.js";
import { ProtocolError } from "./errors.js";
import { PRECOP_MAINNET_VERIFICATION } from "./verification.js";
export class PrecopCRCAdapter {
  readonly id = "precop";
  private readonly baseUrl: string | null;
  private readonly fetchImpl: typeof fetch;
  constructor(baseUrl: string | null, fetchImpl: typeof fetch = fetch) {
    this.baseUrl = baseUrl;
    this.fetchImpl = fetchImpl;
  }
  getVerificationStatus(): VerificationStatus {
    return PRECOP_MAINNET_VERIFICATION;
  }
  private requireVerified(op: keyof VerificationStatus): void {
    const status = PRECOP_MAINNET_VERIFICATION[op];
    if (status !== "VERIFIED") {
      throw new ProtocolError(
        "PROTOCOL_NOT_VERIFIED",
        `PRECOP ${op} is not yet verified. Mainnet execution is awaiting protocol verification.`,
        { retryable: false },
      );
    }
  }
  async getHealth(): Promise<ProtocolHealth> {
    if (!this.baseUrl) {
      return {
        state: "UNSAFE",
        synced: false,
        stateValid: false,
        lagBlocks: 0n,
      };
    }
    try {
      const res = await this.fetchImpl(this.baseUrl, {
        signal: AbortSignal.timeout(5000),
      });
      return {
        state: res.ok ? "HEALTHY" : "DEGRADED",
        synced: res.ok,
        stateValid: res.ok,
        lagBlocks: 0n,
      };
    } catch {
      return {
        state: "UNSAFE",
        synced: false,
        stateValid: false,
        lagBlocks: 0n,
      };
    }
  }
  async getCurrentHeight(): Promise<bigint> {
    this.requireVerified("transfer");
    throw new ProtocolError(
      "PROTOCOL_UNAVAILABLE",
      "PRECOP height unavailable in read-only mode.",
    );
  }
  async getStateHash(): Promise<string> {
    return "";
  }
  async getTokenByTicker(): Promise<ProtocolToken | null> {
    return null;
  }
  async getTokenByDeployment(): Promise<ProtocolToken | null> {
    return null;
  }
  async getListing(): Promise<ProtocolListing | null> {
    return null;
  }
  async buildDeploy(): Promise<UnsignedProtocolTransaction> {
    this.requireVerified("deploy");
    throw new ProtocolError("PROTOCOL_NOT_VERIFIED", "deploy");
  }
  async validateDeploy(): Promise<ValidationResult> {
    return {
      valid: false,
      errors: ["PRECOP deploy not verified."],
      warnings: [],
    };
  }
  async buildMint(): Promise<UnsignedProtocolTransaction> {
    this.requireVerified("mint");
    throw new ProtocolError("PROTOCOL_NOT_VERIFIED", "mint");
  }
  async validateMint(): Promise<ValidationResult> {
    return {
      valid: false,
      errors: ["PRECOP mint not verified."],
      warnings: [],
    };
  }
  async buildSellListing(): Promise<UnsignedProtocolTransaction> {
    this.requireVerified("dexAsk");
    throw new ProtocolError("PROTOCOL_NOT_VERIFIED", "dexAsk");
  }
  async validateSellListing(): Promise<ValidationResult> {
    return {
      valid: false,
      errors: ["PRECOP dex ask not verified."],
      warnings: [],
    };
  }
  async buildBuySettlement(): Promise<UnsignedProtocolTransaction> {
    this.requireVerified("dexBid");
    throw new ProtocolError("PROTOCOL_NOT_VERIFIED", "dexBid");
  }
  async validateBuySettlement(): Promise<ValidationResult> {
    return {
      valid: false,
      errors: ["PRECOP dex bid not verified."],
      warnings: [],
    };
  }
  async buildCancelListing(): Promise<UnsignedProtocolTransaction> {
    this.requireVerified("cancel");
    throw new ProtocolError("PROTOCOL_NOT_VERIFIED", "cancel");
  }
  async validateCancelListing(): Promise<ValidationResult> {
    return {
      valid: false,
      errors: ["PRECOP cancel not verified."],
      warnings: [],
    };
  }
  async broadcast(): Promise<string> {
    throw new ProtocolError(
      "PROTOCOL_NOT_VERIFIED",
      "PRECOP broadcast not verified.",
    );
  }
  async getTransaction(txid: string): Promise<ProtocolTransactionStatus> {
    return { txid, status: "UNKNOWN", confirmations: 0, blockHeight: null };
  }
  async getEvents(): Promise<ProtocolEvent[]> {
    return [];
  }
  async decodeTransaction(): Promise<DecodedProtocolTransaction> {
    throw new ProtocolError(
      "PROTOCOL_NOT_VERIFIED",
      "PRECOP decode not verified.",
    );
  }
  async decodeSignedTransaction(): Promise<DecodedSignedTransaction> {
    throw new ProtocolError(
      "PROTOCOL_NOT_VERIFIED",
      "PRECOP decode not verified.",
    );
  }
}
