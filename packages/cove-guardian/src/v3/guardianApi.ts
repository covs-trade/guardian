import type * as bitcoin from "bitcoinjs-lib";
import type { CoveCanonicalView } from "@crclaunch/cove-covenant";
import type { VaultRecoveryProfile } from "@crclaunch/cove-vault";
import type { SignedTransitionResult, GuardianV3Network } from "./types.js";
import type { FundingInputChecker } from "./funding.js";
export interface GuardianSignRequestWire {
  requestId: string;
  operation: "MINT" | "REDEEM";
  network: GuardianV3Network;
  psbtBase64: string;
  tokenId: string;
}
export interface GuardianSignSuccess {
  ok: true;
  sigHex: string;
  signedPsbtBase64: string;
  profileHash: string;
  guardianXOnly: string;
  resultJson: string;
}
export interface GuardianSignFailure {
  ok: false;
  reason: string;
  detail: string;
}
export type GuardianSignResponseWire =
  GuardianSignSuccess | GuardianSignFailure;
export interface GuardianHealthWire {
  reachable: boolean;
  releaseId: string;
  profileHash: string;
  guardianXOnly: string;
  auditHeadHash: string;
  auditHealthy: boolean;
  signingJournalHealthy: boolean;
  custodyBackendReady: boolean;
  signingEnabled: boolean;
}
export interface GuardianTransport {
  health(): Promise<GuardianHealthWire>;
  sign(req: GuardianSignRequestWire): Promise<GuardianSignResponseWire>;
}
export interface GuardianSignServiceRequest {
  psbt: bitcoin.Psbt;
  view: CoveCanonicalView;
  network: GuardianV3Network;
  recoveryKeyXOnly: Buffer;
  recoveryProfile?: VaultRecoveryProfile;
  feeScript: Buffer;
  maxMinerFeeSats?: bigint;
  buyFeeBps?: bigint;
  redeemFeeBps?: bigint;
  fundingChecker: FundingInputChecker;
}
export type GuardianSignServiceOutcome =
  | SignedTransitionResult
  | {
      ok: false;
      reason: string;
      detail: string;
    };
export interface GuardianSigningService {
  signMint(
    req: GuardianSignServiceRequest,
  ): Promise<GuardianSignServiceOutcome>;
  signRedeem(
    req: GuardianSignServiceRequest,
  ): Promise<GuardianSignServiceOutcome>;
}
export function stringifyBigint(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    typeof val === "bigint" ? { __bigint: val.toString() } : val,
  );
}
export function parseBigint<T>(s: string): T {
  return JSON.parse(s, (_k, val) =>
    val && typeof val === "object" && typeof val.__bigint === "string"
      ? BigInt(val.__bigint)
      : val,
  ) as T;
}
export function extractWitnessSig(witness: Buffer): Buffer {
  let off = 0;
  const readVarInt = (): number => {
    const b = witness[off]!;
    off += 1;
    if (b < 0xfd) return b;
    if (b === 0xfd) {
      const v = witness.readUInt16LE(off);
      off += 2;
      return v;
    }
    if (b === 0xfe) {
      const v = witness.readUInt32LE(off);
      off += 4;
      return v;
    }
    const v = Number(witness.readBigUInt64LE(off));
    off += 8;
    return v;
  };
  const count = readVarInt();
  if (count < 1) throw new Error("empty witness");
  const len = readVarInt();
  return Buffer.from(witness.subarray(off, off + len));
}
export interface InProcessGuardianTransportOptions {
  signer: GuardianSigningService;
  profileHash: string;
  guardianXOnly: string;
  network: "regtest" | "signet" | "testnet" | "mainnet";
  decode: (psbtBase64: string) => {
    psbt: bitcoin.Psbt;
  };
  loadView: (tokenId: string) => Promise<CoveCanonicalView>;
  recoveryKeyXOnly: Buffer;
  recoveryProfile?: VaultRecoveryProfile;
  feeScript: Buffer;
  maxMinerFeeSats?: bigint;
  buyFeeBps?: bigint;
  redeemFeeBps?: bigint;
  fundingChecker: FundingInputChecker;
  healthProbe?: () => Promise<GuardianHealthProbe>;
}
export interface GuardianHealthProbe {
  releaseId: string;
  auditHeadHash: string;
  auditHealthy: boolean;
  signingJournalHealthy: boolean;
  custodyBackendReady: boolean;
}
export class InProcessGuardianTransport implements GuardianTransport {
  constructor(private readonly opts: InProcessGuardianTransportOptions) {}
  async health(): Promise<GuardianHealthWire> {
    const base = {
      reachable: true,
      profileHash: this.opts.profileHash,
      guardianXOnly: this.opts.guardianXOnly,
    };
    if (!this.opts.healthProbe) {
      return {
        ...base,
        releaseId: "in-process-fixture",
        auditHeadHash: "0".repeat(64),
        auditHealthy: true,
        signingJournalHealthy: true,
        custodyBackendReady: true,
        signingEnabled: true,
      };
    }
    const p = await this.opts.healthProbe();
    return {
      ...base,
      ...p,
      signingEnabled:
        p.custodyBackendReady && p.auditHealthy && p.signingJournalHealthy,
    };
  }
  async sign(req: GuardianSignRequestWire): Promise<GuardianSignResponseWire> {
    const { psbt } = this.opts.decode(req.psbtBase64);
    const view = await this.opts.loadView(req.tokenId);
    const base = {
      network: this.opts.network,
      recoveryKeyXOnly: this.opts.recoveryKeyXOnly,
      recoveryProfile: this.opts.recoveryProfile,
      feeScript: this.opts.feeScript,
      maxMinerFeeSats: this.opts.maxMinerFeeSats,
      buyFeeBps: this.opts.buyFeeBps,
      redeemFeeBps: this.opts.redeemFeeBps,
      fundingChecker: this.opts.fundingChecker,
    };
    const outcome =
      req.operation === "MINT"
        ? await this.opts.signer.signMint({ psbt, view, ...base })
        : await this.opts.signer.signRedeem({ psbt, view, ...base });
    if (!outcome.ok)
      return { ok: false, reason: outcome.reason, detail: outcome.detail };
    const w = psbt.data.inputs[0]!.finalScriptWitness!;
    const sig = extractWitnessSig(w);
    return {
      ok: true,
      sigHex: sig.toString("hex"),
      signedPsbtBase64: psbt.toBase64(),
      profileHash: this.opts.profileHash,
      guardianXOnly: this.opts.guardianXOnly,
      resultJson: stringifyBigint(outcome),
    };
  }
}
export class HttpGuardianTransport implements GuardianTransport {
  private readonly endpoint: string;
  private readonly authToken: string;
  private readonly timeoutMs: number;
  constructor(endpoint: string, authToken: string, timeoutMs = 10000) {
    const url = new URL(endpoint);
    const local =
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "::1" ||
      url.hostname === "[::1]";
    const railwayPrivate =
      url.protocol === "http:" && url.hostname.endsWith(".railway.internal");
    if (url.protocol !== "https:" && !local && !railwayPrivate) {
      throw new Error(
        "HttpGuardianTransport requires an https:// endpoint (or localhost, or http on *.railway.internal)",
      );
    }
    if (!authToken)
      throw new Error("HttpGuardianTransport requires a bearer token");
    this.endpoint = endpoint;
    this.authToken = authToken;
    this.timeoutMs = timeoutMs;
  }
  async health(): Promise<GuardianHealthWire> {
    return (await this.request("GET", "/health")) as GuardianHealthWire;
  }
  async sign(req: GuardianSignRequestWire): Promise<GuardianSignResponseWire> {
    return (await this.request(
      "POST",
      "/sign",
      req,
    )) as GuardianSignResponseWire;
  }
  private async request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const res = await fetch(`${this.endpoint}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.authToken}`,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok)
      throw new Error(`guardian ${method} ${path}: HTTP ${res.status}`);
    return res.json();
  }
}
