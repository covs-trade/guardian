import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { randomBytes } from "node:crypto";
import { eq, and, sql, isNull } from "drizzle-orm";
import {
  schema,
  PostgresRpcBudget,
  providerAccount,
  databaseDate,
  effectiveBackingObservation,
  getSubmission,
  prepareSubmission,
  claimSubmission,
  saveSignedSubmission,
  publishSubmission,
  deferSubmission,
  dueSubmissions,
  haltSubmission,
  resumeSubmission,
  SubmissionError,
  type Submission,
  type Database,
} from "@crclaunch/db";
import {
  isRpcNotFound,
  broadcastRecordedTransaction,
  type CoreRpcProvider,
  type BlockchainInfo,
} from "@crclaunch/bitcoin";
import { buildBackingVaultV3 } from "@crclaunch/cove-vault";
import {
  TOKEN_CARRIER_SATS,
  applyMintV2,
  applyRedeemV2,
  stateHashV2,
  type CoveStateV2,
  type CoveCanonicalView,
} from "@crclaunch/cove-covenant";
import {
  buildDeployPsbtV3,
  buildMintPsbtV3,
  buildRedeemPsbtV3,
  buildTransferPsbtV2,
  validateFinalizedDeployTransaction,
  validateFinalizedMintTransaction,
  validateFinalizedRedeemTransaction,
  validateFinalizedTransferTransaction,
  RESERVE_ANCHOR_SATS,
  decodeCoveOpReturnTx,
  type ValidatedCoveTransaction,
  type ResolvedInput,
  type GuardianTransitionSigner,
  type TransitionSignRequest,
  validateMintTransitionV3,
  validateRedeemTransitionV3,
  chainFundingChecker,
  ordAssetLookup,
  type AssetLookup,
  type FundingInputChecker,
} from "@crclaunch/cove-guardian/v3";
import {
  loadCanonicalViewSnapshotFromDb,
  computeHealth,
  healthChainObservation,
  type HealthReport,
  getTokenUtxosByScriptDb,
  getLiveTokenUtxosAtDb,
} from "@crclaunch/cove-indexer/v3";
import {
  grossBuy,
  grossRedeem,
  mintFeeSats,
  redeemFeeSats,
  creatorFeeSats,
  CREATOR_RECORD_SATS,
  LAUNCH_FEE_SATS,
  redeemWalletFundingTarget,
  dustThreshold,
} from "@crclaunch/cove-economics";
import {
  ATOMS_PER_TOKEN,
  LOT_TOKENS,
  PUBLIC_SUPPLY_ATOMS,
} from "@crclaunch/curve";
import {
  canonicalTicker,
  computeTokenId,
  OP_MINT,
  OP_REDEEM,
  type ParsedEnvelopeV2,
} from "@crclaunch/cove-wire";
import {
  MarketService,
  publicListing,
  defaultMarketConfig,
  mainnetMarketConfig,
  listingIdOf,
  cancellationHashOf,
  cancellationMessageToSign,
  getBuyRoutes,
  getSellOptions,
  type ListingV1,
} from "@crclaunch/cove-market";
import { indexedBackingConflictQuery } from "./backing-conflict.js";
import { AppError } from "./errors.js";
import { DEV_RISK_POLICY } from "./transition-signer.js";
import type { V3AppConfig, V3Network } from "./config.js";
import { checkCoreAgreement, verifyMainnetGenesis } from "./readiness.js";
import {
  unsignedTxDigest,
  parsePsbt,
  btcNetwork,
  validateInputSignature,
  walletDeltaSats,
} from "./psbt.js";
import {
  resolveFundingUtxos,
  resolveCachedFundingUtxos,
  cachedBuildFundingChecker,
  validateFundingCandidates,
  type FundingCandidate,
  type ResolvedFunding,
} from "./funding.js";
import {
  resolveWalletIdentity,
  walletIdentityFrom,
  type ResolvedWalletIdentity,
} from "./wallet-identity.js";
import {
  estimateOperationVsize,
  resolveMinerFee,
  FeeError,
  type CoveOperation,
  type FeeRates,
} from "./fees.js";
import {
  createTxSession,
  requireTxSession,
  listSubmittedSpendsOfBacking,
  type TxSessionRow,
} from "./tx-session.js";
import {
  upsertTokenMetadata,
  validateMetadata,
  type TokenMetadataInput,
} from "./metadata.js";
import {
  listV3Tokens,
  getV3TokenDetail,
  getTokenHolders,
  getTokenActivity,
} from "./token-read.js";
import { getWalletPortfolio } from "./wallet-read.js";
import { getV3Status } from "./health.js";
import { readFeeObservation } from "./runtime-snapshot.js";

bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);

export interface LaunchPrepareInput {
  ticker: string;
  displayName: string;
  description: string;
  websiteUrl?: string | null;
  xUrl?: string | null;
  imageUrl?: string | null;
  nonceHex?: string;

  creatorScript?: string;
}

export interface LaunchPrepareResult {
  tokenId: string | null;
  ticker: string;
  nonceHex: string;
  policyVersion: number;
  chainIdentity: string;
  publicCapAtoms: bigint;

  publicSupplyAtoms: bigint;
  curve: string;
  vaultAnchorSats: bigint;

  launchFeeSats: bigint;
}

export interface BackingQuote {
  tokenId: string;
  amountAtoms: bigint;
  stateHash: string;
  backingOutpoint: { txid: string; vout: number };
  supplyBeforeAtoms: bigint;
  supplyAfterAtoms: bigint;
  backingBeforeSats: bigint;
  backingAfterSats: bigint;
  grossSats: bigint;
  feeSats: bigint;

  creatorFeeSats: bigint;
  feeBps: bigint;
  indexedHeight: bigint;
  indexedBlockHash: string;
  expiresAtHeight: bigint;
}

export interface RedeemQuote {
  tokenId: string;
  amountAtoms: bigint;
  stateHash: string;
  backingOutpoint: { txid: string; vout: number };
  supplyBeforeAtoms: bigint;
  supplyAfterAtoms: bigint;
  backingBeforeSats: bigint;
  backingAfterSats: bigint;
  grossSats: bigint;
  feeSats: bigint;
  netSats: bigint;
}

export interface IntentV3 {
  operation: "DEPLOY" | "BACKING_BUY" | "REDEEM" | "TRANSFER";
  tokenId: string | null;
  tokenAmountAtoms: bigint | null;
  grossSats: bigint | null;
  protocolFeeSats: bigint | null;

  creatorFeeSats?: bigint;
  creatorScript?: string;
  minerFeeSats: bigint;
  netSats: bigint | null;
  payoutSats?: bigint;

  walletScript: string;

  ordinalsScript: string;
  stateHash: string | null;
  unsignedTxDigest: string;

  walletDeltaSats: bigint;
}

interface BackingRow {
  state: CoveStateV2;
  stateHash: string;
  input: ResolvedInput;
  chainObservation?: BlockchainInfo;
}

const MAX_TRANSFER_TOKEN_INPUTS = 4;

const DEFAULT_LISTING_BLOCKS = 1_008n;

const MAX_PENDING_BACKING_CHAIN = 24;

const BACKING_SUCCESSOR_VOUT = 1;

export class V3AppService {
  readonly market: MarketService;

  readonly fundingChecker: FundingInputChecker;
  private readonly assets: AssetLookup | null;

  constructor(
    readonly db: Database,
    readonly provider: CoreRpcProvider,
    readonly config: V3AppConfig,
    readonly transitionSigner: GuardianTransitionSigner,
    readonly secondaryProvider: CoreRpcProvider | null = null,
  ) {
    this.assets = config.ordUrl
      ? ordAssetLookup(config.ordUrl, {
          budget: new PostgresRpcBudget(
            db,
            `ord:${providerAccount({ url: config.ordUrl })}`,
            "public",
            3,
          ),
        })
      : null;
    this.fundingChecker = this.createFundingChecker();
    this.market = new MarketService(
      db,
      provider,
      config.network === "mainnet"
        ? mainnetMarketConfig({
            p2pFeeBps: config.p2pFeeBps ?? 50,
            feeScript: config.feeScript,
            maxP2pSettlementSats: config.maxP2pSettlementSats ?? 0n,
            chainIdentity: config.chainIdentity,
          })
        : defaultMarketConfig(
            config.network,
            config.feeScript,
            config.chainIdentity,
          ),
    );
  }

  private assertEnabled(): void {
    if (!this.config.enabled)
      throw new AppError("APP_DISABLED", "covs is disabled on this server");
    if (
      this.config.network === "mainnet" &&
      this.config.mainnetMutationsArmed !== true
    ) {
      throw new AppError("MAINNET_DISABLED", "mainnet mutations are not armed");
    }
  }

  private createFundingChecker(
    observation?: BlockchainInfo,
  ): FundingInputChecker {
    return chainFundingChecker({
      chain: this.provider,
      observation,
      expectedChain:
        this.config.network === "mainnet"
          ? "main"
          : this.config.network === "testnet"
            ? "test"
            : this.config.network,
      isCoveCarrier: async (o) =>
        (await getLiveTokenUtxosAtDb(this.db, this.config.network, [o]))
          .length > 0,
      assets: this.assets ?? undefined,
    });
  }

  private assertNetwork(): V3Network {
    if (
      this.config.network === "mainnet" &&
      this.config.mainnetProfileValid !== true
    ) {
      throw new AppError(
        "MAINNET_DISABLED",
        "mainnet mutations need the committed profile to validate",
      );
    }
    return this.config.network;
  }

  private assertMutating(): V3Network {
    this.assertEnabled();
    return this.assertNetwork();
  }

  private assertCanaryAllowed(params: {
    tokenId?: string;
    walletScript?: string;
  }): void {
    if (
      this.config.canaryAllowedTokenIds &&
      params.tokenId &&
      !this.config.canaryAllowedTokenIds.includes(params.tokenId)
    ) {
      throw new AppError(
        "CANARY_TOKEN_NOT_ALLOWED",
        `token ${params.tokenId} is not in the canary allowlist`,
      );
    }
    if (
      this.config.canaryAllowedWalletScripts &&
      params.walletScript &&
      !this.config.canaryAllowedWalletScripts.includes(
        params.walletScript.toLowerCase(),
      )
    ) {
      throw new AppError(
        "CANARY_WALLET_NOT_ALLOWED",
        "wallet script is not in the canary allowlist",
      );
    }
  }

  private async requireHealthy(): Promise<HealthReport> {
    const health = await computeHealth({
      db: this.db,
      network: this.config.network,
      provider: this.provider,
    });
    if (health.health === "REBUILDING")
      throw new AppError("INDEXER_REBUILDING", "indexer is rebuilding");
    if (health.health === "DIVERGED")
      throw new AppError("INDEXER_DIVERGED", "indexer diverged from Core tip");
    if (health.health === "CORE_UNREACHABLE")
      throw new AppError("CORE_UNAVAILABLE", "Bitcoin Core unreachable");
    if (health.health === "BEHIND")
      throw new AppError(
        "INDEXER_UNHEALTHY",
        "indexer behind by " + health.lag,
      );

    if (this.secondaryProvider) {
      const agreement = await checkCoreAgreement(
        this.provider,
        this.secondaryProvider,
        {
          primaryInfo: healthChainObservation(health, this.provider),
        },
      );
      if (!agreement.agreed)
        throw new AppError(
          "CORE_UNAVAILABLE",
          `Core disagreement: ${agreement.detail ?? "unknown"}`,
        );
    }

    if (this.config.network === "mainnet") {
      if (!(await verifyMainnetGenesis(this.provider))) {
        throw new AppError(
          "CORE_UNAVAILABLE",
          "primary Core is not on Bitcoin mainnet (genesis hash mismatch)",
        );
      }
      if (
        this.secondaryProvider &&
        !(await verifyMainnetGenesis(this.secondaryProvider))
      ) {
        throw new AppError(
          "CORE_UNAVAILABLE",
          "secondary Core is not on Bitcoin mainnet (genesis hash mismatch)",
        );
      }
    }
    return health;
  }

  private validateTokenAmount(
    tokenId: string,
    amountAtoms: bigint,
    multiple = 1n,
  ): void {
    if (!/^[0-9a-f]{64}$/i.test(tokenId))
      throw new AppError("TOKEN_NOT_FOUND", "token id must be 32-byte hex");
    if (
      typeof amountAtoms !== "bigint" ||
      amountAtoms <= 0n ||
      amountAtoms > PUBLIC_SUPPLY_ATOMS ||
      amountAtoms % multiple !== 0n
    )
      throw new AppError("TOKEN_AMOUNT_INVALID", "invalid token amount");
  }

  status() {
    return getV3Status({ db: this.db, config: this.config });
  }
  listTokens(opts?: { ticker?: string; search?: string; limit?: number }) {
    return listV3Tokens(this.db, this.config.network, opts);
  }
  tokenDetail(tokenId: string) {
    return getV3TokenDetail(this.db, this.config.network, tokenId);
  }
  tokenHolders(tokenId: string, limit?: number, offset = 0) {
    return getTokenHolders(
      this.db,
      this.config.network,
      tokenId,
      limit,
      offset,
    );
  }
  tokenActivity(tokenId: string, limit?: number) {
    return getTokenActivity(this.db, this.config.network, tokenId, limit);
  }
  walletPortfolio(
    walletScript: string,
    opts?: { limit?: number; offset?: number },
  ) {
    return getWalletPortfolio(this.db, this.config.network, walletScript, opts);
  }

  private async loadBacking(tokenId: string): Promise<BackingRow> {
    return this.followPendingBacking(
      tokenId,
      await this.loadConfirmedBacking(tokenId),
    );
  }

  private async loadQuoteBacking(tokenId: string) {
    const observation = await effectiveBackingObservation(
      this.db,
      this.config.network,
      tokenId,
    );
    if (!observation) throw new AppError("TOKEN_NOT_FOUND", "token not found");
    const p = observation.payload;
    return {
      state: {
        stateVersion: p.stateVersion as 2,
        policyVersion: p.policyVersion,
        tokenId,
        issuedPublicSupplyAtoms: BigInt(p.issuedSupplyAtoms),
        backingSats: BigInt(p.backingSats),
        curveStage: p.curveStage,
      },
      stateHash: p.stateHash,
      input: {
        txid: p.txid,
        vout: p.vout,
        script: Buffer.from(p.script, "hex"),
        valueSats: BigInt(p.valueSats),
      },
      indexedHeight: observation.indexedHeight,
      indexedBlockHash: observation.indexedHash,
    };
  }

  private async loadConfirmedBacking(tokenId: string): Promise<BackingRow> {
    const rows = await this.db
      .select()
      .from(schema.coveV3BackingStates)
      .where(
        and(
          eq(schema.coveV3BackingStates.network, this.config.network),
          eq(schema.coveV3BackingStates.tokenId, tokenId),
          eq(schema.coveV3BackingStates.canonical, true),
        ),
      );
    const b = rows[0];
    if (!b) throw new AppError("TOKEN_NOT_FOUND", "token not found");
    const state: CoveStateV2 = {
      stateVersion: b.stateVersion as 2,
      policyVersion: b.policyVersion,
      tokenId: b.tokenId,
      issuedPublicSupplyAtoms: b.issuedSupplyAtoms,
      backingSats: b.backingSats,
      curveStage: b.curveStage,
    };
    const confirmed: BackingRow = {
      state,
      stateHash: b.stateHash,
      input: {
        txid: b.txid,
        vout: b.vout,
        script: Buffer.from(b.scriptPubKey, "hex"),
        valueSats: b.btcValue,
      },
    };
    return confirmed;
  }

  private async loadBackingAt(
    tokenId: string,
    txid: string | null,
    vout: number | null,
  ): Promise<BackingRow> {
    const confirmed = await this.loadConfirmedBacking(tokenId);
    if (!txid || vout === null)
      return this.followPendingBacking(tokenId, confirmed);
    return this.followPendingBacking(tokenId, confirmed, { txid, vout });
  }

  private async followPendingBacking(
    tokenId: string,
    confirmed: BackingRow,
    stopAt?: { txid: string; vout: number },
  ): Promise<BackingRow> {
    let tip = confirmed;
    const visited: string[] = [];
    const cursor = () =>
      this.db.execute(sql`select c.height::text as height, c.block_hash,
      c.rebuilding, e.chain_generation::text as generation from cove_v3_cursor c
      left join cove_observation_epochs e on e.network = c.network
      where c.network = ${this.config.network}`);
    const captured = (await cursor()).rows[0];
    if (!captured || captured.rebuilding)
      throw new AppError(
        "STATE_CHANGED",
        "the indexed chain is not ready for pending verification",
      );
    let chain;
    try {
      chain = await this.provider.getBlockchainInfo({ retry: false });
    } catch {
      throw new AppError(
        "CORE_UNAVAILABLE",
        "the chain tip cannot currently be observed",
      );
    }
    let membership: Set<string> | undefined;
    const readMembership = async () => {
      try {
        return await this.provider.getMempoolSnapshot({ retry: false });
      } catch {
        throw new AppError(
          "CORE_UNAVAILABLE",
          "the pending branch cannot currently be observed",
        );
      }
    };
    const verifyFence = async () => {
      if (visited.length) {
        const current = await readMembership();
        if (visited.some((txid) => !current.has(txid)))
          throw new AppError(
            "STATE_CHANGED",
            "the pending branch changed during observation",
          );
      }
      let currentChain;
      try {
        currentChain = await this.provider.getBlockchainInfo({ retry: false });
      } catch {
        throw new AppError(
          "CORE_UNAVAILABLE",
          "the chain tip cannot currently be verified",
        );
      }
      const current = (await cursor()).rows[0];
      if (
        currentChain.bestBlockHash !== chain.bestBlockHash ||
        currentChain.blocks !== chain.blocks ||
        !current ||
        current.rebuilding ||
        current.height !== captured.height ||
        current.block_hash !== captured.block_hash ||
        current.generation !== captured.generation
      )
        throw new AppError(
          "STATE_CHANGED",
          "the chain changed during pending verification",
        );
      tip = { ...tip, chainObservation: currentChain };
    };

    for (let depth = 0; depth < MAX_PENDING_BACKING_CHAIN; depth++) {
      if (
        stopAt &&
        tip.input.txid === stopAt.txid &&
        tip.input.vout === stopAt.vout
      ) {
        await verifyFence();
        return tip;
      }
      let spendingTxid: string | null | undefined;
      try {
        spendingTxid = await this.provider.getMempoolSpender(
          tip.input.txid,
          tip.input.vout,
          {
            retry: false,
            signal: AbortSignal.timeout(5_000),
          },
        );
      } catch {
        throw new AppError(
          "CORE_UNAVAILABLE",
          "the pending branch cannot currently be observed",
        );
      }
      let next: { txid: string } | null = spendingTxid
        ? { txid: spendingTxid }
        : null;
      if (spendingTxid === undefined) {
        membership ??= await readMembership();
        const candidates = await listSubmittedSpendsOfBacking(
          this.db,
          this.config.network,
          tokenId,
          tip.input.txid,
          tip.input.vout,
          membership,
        );
        if (candidates.length > 64)
          throw new AppError(
            "STATE_CHANGED",
            "too many pending competitors; retry after reconciliation",
          );
        for (const candidate of candidates) {
          if (!candidate.txid) continue;
          if (next)
            throw new AppError(
              "STATE_CHANGED",
              "the accepted branch changed during observation",
            );
          next = { txid: candidate.txid };
        }
      }
      if (!next) {
        if (stopAt)
          throw new AppError(
            "STATE_CHANGED",
            "the requested backing is no longer on the accepted branch; request a fresh quote",
          );
        await verifyFence();
        let unspent;
        try {
          unspent = await this.provider.getTxout(
            tip.input.txid,
            tip.input.vout,
          );
        } catch {
          throw new AppError(
            "CORE_UNAVAILABLE",
            "the backing output cannot currently be observed",
          );
        }
        if (
          !unspent ||
          unspent.scriptPubKeyHex !== tip.input.script.toString("hex") ||
          unspent.valueSats !== tip.input.valueSats
        ) {
          throw new AppError(
            "STATE_CHANGED",
            "the backing output has changed; request a fresh quote",
          );
        }
        return tip;
      }
      visited.push(next.txid);

      let raw: string;
      try {
        raw = await this.provider.getRawTransaction(next.txid);
      } catch (error) {
        throw new AppError(
          isRpcNotFound(error, "getrawtransaction")
            ? "STATE_CHANGED"
            : "CORE_UNAVAILABLE",
          "the pending backing transaction cannot currently be verified",
        );
      }

      let tx: bitcoin.Transaction;
      try {
        tx = bitcoin.Transaction.fromHex(raw);
      } catch {
        throw new AppError(
          "STATE_CHANGED",
          "the pending backing transaction is invalid",
        );
      }
      if (
        tx.getId() !== next.txid ||
        !tx.ins[0] ||
        Buffer.from(tx.ins[0].hash).reverse().toString("hex") !==
          tip.input.txid ||
        tx.ins[0].index !== tip.input.vout
      ) {
        throw new AppError(
          "STATE_CHANGED",
          "the pending transaction does not spend the expected backing",
        );
      }
      let envelope: ParsedEnvelopeV2;
      try {
        envelope = decodeCoveOpReturnTx(tx);
      } catch {
        throw new AppError(
          "STATE_CHANGED",
          "the pending backing transaction is invalid",
        );
      }

      if (
        !("tokenId" in envelope) ||
        !envelope.tokenId.equals(Buffer.from(tokenId, "hex"))
      )
        throw new AppError(
          "STATE_CHANGED",
          "the pending transaction belongs to another token",
        );
      let nextState: CoveStateV2;
      if (envelope.op === OP_MINT) {
        nextState = applyMintV2(tip.state, envelope.amount).nextState;
      } else if (envelope.op === OP_REDEEM) {
        nextState = applyRedeemV2(tip.state, envelope.redeemAmount).nextState;
      } else {
        throw new AppError(
          "STATE_CHANGED",
          "the pending transaction does not move the backing vault",
        );
      }

      const vaultOut = tx.outs[BACKING_SUCCESSOR_VOUT];
      const expectedValue = RESERVE_ANCHOR_SATS + nextState.backingSats;
      const nextVault = buildBackingVaultV3({
        state: nextState,
        guardianXOnly: this.config.guardianXOnly,
        recoveryKeyXOnly: this.config.recoveryKeyXOnly,
        recoveryProfile: this.config.recoveryProfile,
        network: btcNetwork(this.config.network),
      });
      if (
        !vaultOut ||
        !vaultOut.script.equals(nextVault.scriptPubKey) ||
        BigInt(vaultOut.value) !== expectedValue
      )
        throw new AppError(
          "STATE_CHANGED",
          "the pending backing output cannot be verified",
        );

      tip = {
        state: nextState,
        stateHash: stateHashV2(nextState),
        input: {
          txid: tx.getId(),
          vout: BACKING_SUCCESSOR_VOUT,
          script: Buffer.from(vaultOut.script),
          valueSats: expectedValue,
        },
      };
    }
    throw new AppError(
      "STATE_CHANGED",
      "the pending backing chain exceeds the verification limit",
    );
  }

  private overlayPendingBacking(
    view: CoveCanonicalView,
    tokenIdHex: string,
    tip: BackingRow,
  ): CoveCanonicalView {
    const tipOutpoint = { txid: tip.input.txid, vout: tip.input.vout };
    const matches = (tokenId: Buffer) => tokenId.toString("hex") === tokenIdHex;
    return {
      cursorHeight: view.cursorHeight,
      getBackingOutpoint: (tokenId) =>
        matches(tokenId) ? tipOutpoint : view.getBackingOutpoint(tokenId),
      getCurrentBackingState: (tokenId) =>
        matches(tokenId) ? tip.state : view.getCurrentBackingState(tokenId),
      getBackingStateByOutpoint: (outpoint) =>
        outpoint.txid === tipOutpoint.txid && outpoint.vout === tipOutpoint.vout
          ? tip.state
          : view.getBackingStateByOutpoint(outpoint),
      getTokenUtxo: (outpoint) => view.getTokenUtxo(outpoint),
      getTokenCreatorScript: (tokenId) =>
        view.getTokenCreatorScript?.(tokenId) ?? null,
    };
  }

  private async creatorScriptOf(tokenId: string): Promise<Buffer> {
    const rows = await this.db
      .select({ creatorScript: schema.coveV3Tokens.creatorScript })
      .from(schema.coveV3Tokens)
      .where(
        and(
          eq(schema.coveV3Tokens.network, this.config.network),
          eq(schema.coveV3Tokens.tokenId, tokenId),
          eq(schema.coveV3Tokens.canonical, true),
        ),
      );
    const c = rows[0]?.creatorScript;
    if (!c)
      throw new AppError("TOKEN_NOT_FOUND", "token has no recorded creator");
    return Buffer.from(c, "hex");
  }

  private async loadView(
    tokenId: string,
    relevantOutpoints: { txid: string; vout: number }[] = [],
  ): Promise<CoveCanonicalView> {
    return loadCanonicalViewSnapshotFromDb({
      db: this.db,
      network: this.config.network,
      tokenId,
      relevantOutpoints,
    });
  }

  async feeRates(): Promise<FeeRates> {
    return readFeeObservation(this.db, this.config.network);
  }

  private async assetsAt(o: {
    txid: string;
    vout: number;
  }): Promise<string | null> {
    if (!this.assets) return null;
    try {
      return await this.assets.describeAssets(o);
    } catch (e) {
      throw new AppError(
        "FUNDING_CHECK_UNAVAILABLE",
        `could not check ${o.txid}:${o.vout} for inscriptions and runes: ${(e as Error).message}`,
      );
    }
  }

  private async resolveFundingAndFee(params: {
    op: CoveOperation;
    wallet: ResolvedWalletIdentity;
    candidates: FundingCandidate[];
    targetSats: bigint;
    tokenInputs?: number;
    recipientCarriers?: number;
    discovery?: boolean;
    feeRateSatPerVb?: bigint;
    explicitMinerFeeSats?: bigint;
    cachedFunding?: ResolvedFunding[];
  }): Promise<{
    inputs: ResolvedInput[];
    minerFeeSats: bigint;
    vsize: number;
    satPerVb: bigint;
  }> {
    const resolved =
      params.cachedFunding ??
      (await resolveFundingUtxos(this.provider, params.candidates));
    for (const f of resolved) {
      if (f.script.toString("hex") !== params.wallet.payments.script) {
        throw new AppError(
          "FUNDING_INPUT_INVALID",
          "funding input script does not match wallet",
        );
      }
    }

    const carriers = await getLiveTokenUtxosAtDb(
      this.db,
      this.config.network,
      params.candidates,
    );
    if (carriers.length > 0) {
      throw new AppError(
        "FUNDING_INPUT_IS_TOKEN",
        `funding input ${carriers[0]!.txid}:${carriers[0]!.vout} holds tokens and cannot pay for a trade`,
      );
    }
    const rates = await this.feeRates();

    const standard =
      rates.tiers.find((t) => t.key === "standard") ?? rates.tiers[0]!;
    const feeRateSatPerVb =
      params.feeRateSatPerVb ??
      (params.explicitMinerFeeSats === undefined
        ? standard.satPerVb
        : undefined);
    const shape = {
      tokenInputs: params.tokenInputs,

      fundingKind: params.wallet.payments.kind,
      tokenKind: params.wallet.ordinals.kind,
      walletScriptBytes: params.wallet.payments.script.length / 2,
      ordinalsScriptBytes: params.wallet.ordinals.script.length / 2,
      feeScriptBytes: this.config.feeScript.length,
      recipientCarriers: params.recipientCarriers,
      discovery: params.discovery,
    };
    const priceAt = (fundingInputs: number) => {
      const vsize = estimateOperationVsize(params.op, {
        ...shape,
        fundingInputs,
      });
      let fee;
      try {
        fee = resolveMinerFee({
          rateSatPerVb: feeRateSatPerVb,
          explicitSats: params.explicitMinerFeeSats,
          vsize,
          floorSatPerVb: rates.floorSatPerVb,
          ceilingSatPerVb: rates.ceilingSatPerVb,
          maxMinerFeeSats: this.config.maxMinerFeeSats,
        });
      } catch (e) {
        if (e instanceof FeeError)
          throw new AppError(e.code, e.message.replace(/^\[[A-Z_]+\]\s*/, ""));
        throw e;
      }
      return {
        vsize: fee.vsize,
        minerFeeSats: fee.minerFeeSats,
        satPerVb: fee.effectiveSatPerVb,
      };
    };

    const vaultOp = params.op === "BACKING_BUY" || params.op === "REDEEM";
    const pending = vaultOp ? resolved.filter((f) => f.confirmations < 1) : [];
    const usable = vaultOp
      ? resolved.filter((f) => f.confirmations >= 1)
      : resolved;

    let sorted = [...usable].sort((a, b) => {
      if (a.valueSats !== b.valueSats)
        return a.valueSats > b.valueSats ? -1 : 1;
      if (a.txid !== b.txid) return a.txid < b.txid ? -1 : 1;
      return a.vout - b.vout;
    });

    const toInput = (f: ResolvedFunding): ResolvedInput => ({
      txid: f.txid,
      vout: f.vout,
      script: f.script,
      valueSats: f.valueSats,
      publicKey: params.wallet.payments.publicKeyBuffer,
    });

    const noFunding = priceAt(0);
    if (params.targetSats + noFunding.minerFeeSats <= 0n) {
      return { inputs: [], ...noFunding };
    }

    const skippedAssets: string[] = [];
    let chosen: ResolvedFunding[] = [];
    let sum = 0n;
    pick: for (;;) {
      chosen = [];
      sum = 0n;
      for (const utxo of sorted) {
        chosen.push(utxo);
        sum += utxo.valueSats;
        const priced = priceAt(chosen.length);
        if (sum >= params.targetSats + priced.minerFeeSats) {
          for (const f of chosen) {
            const held = params.cachedFunding ? null : await this.assetsAt(f);
            if (held) {
              skippedAssets.push(`${f.txid}:${f.vout} (${held})`);
              sorted = sorted.filter((u) => u !== f);
              continue pick;
            }
          }
          return { inputs: chosen.map(toInput), ...priced };
        }
      }
      break;
    }
    const shortfall = priceAt(Math.max(1, chosen.length));
    const need = params.targetSats + shortfall.minerFeeSats;

    const twoAddress =
      params.wallet.payments.script !== params.wallet.ordinals.script;
    const pendingSats = pending.reduce((a, f) => a + f.valueSats, 0n);
    throw new AppError(
      "INSUFFICIENT_BTC",
      `Your payment address has ${sum} usable sats; this needs ${need} ` +
        `(${params.targetSats} for the trade, ${shortfall.minerFeeSats} network fee at ` +
        `${shortfall.satPerVb} sat/vB).` +
        (pending.length > 0
          ? ` Another ${pendingSats} sats are still unconfirmed; mints and sales use only confirmed BTC, so wait for your last transaction to confirm.`
          : "") +
        (skippedAssets.length > 0
          ? ` Skipped coins holding inscriptions or runes: ${skippedAssets.join(", ")}.`
          : "") +
        (twoAddress
          ? " covs pays only from your wallet's payment (BTC) address, not its token (taproot) address — send BTC there first."
          : ""),
    );
  }

  prepareLaunch(input: LaunchPrepareInput): LaunchPrepareResult {
    this.assertEnabled();
    const ticker = canonicalTicker(input.ticker);
    const nonce = input.nonceHex
      ? Buffer.from(input.nonceHex, "hex")
      : randomBytes(32);
    if (nonce.length !== 32)
      throw new AppError("TOKEN_AMOUNT_INVALID", "nonce must be 32 bytes");

    const creatorScript = input.creatorScript
      ? Buffer.from(input.creatorScript, "hex")
      : null;
    const tokenId = creatorScript
      ? computeTokenId({
          chainIdentity: this.config.chainIdentity,
          policyVersion: 3,
          ticker,
          tokenNonce: nonce,
          creatorScript,
        }).toString("hex")
      : null;
    validateMetadata({
      displayName: input.displayName,
      description: input.description,
      websiteUrl: input.websiteUrl,
      xUrl: input.xUrl,
      imageUrl: input.imageUrl,
    });
    return {
      tokenId,
      ticker,
      nonceHex: nonce.toString("hex"),
      policyVersion: 3,
      chainIdentity: this.config.chainIdentity,
      publicCapAtoms: PUBLIC_SUPPLY_ATOMS,
      publicSupplyAtoms: PUBLIC_SUPPLY_ATOMS,
      curve: "stairs210",
      vaultAnchorSats: RESERVE_ANCHOR_SATS,
      launchFeeSats: LAUNCH_FEE_SATS,
    };
  }

  async buildLaunch(params: {
    ticker: string;
    nonceHex: string;
    walletScript: string;

    ordinalsScript?: string;
    walletPublicKey?: string;
    ordinalsPublicKey?: string;
    walletAddress: string | null;
    funding: FundingCandidate[];

    feeRateSatPerVb?: bigint;

    minerFeeSats?: bigint;
    metadata: TokenMetadataInput;
    idempotencyKey: string;
  }): Promise<{
    sessionId: string;
    psbtBase64: string;
    intent: IntentV3;
    tokenId: string;
  }> {
    this.assertMutating();
    const wallet = resolveWalletIdentity(walletIdentityFrom(params));
    validateFundingCandidates(params.funding);
    const metadataJson = validateMetadata(params.metadata);
    if (!/^[0-9a-f]{64}$/i.test(params.nonceHex))
      throw new AppError("TOKEN_AMOUNT_INVALID", "nonce must be 32-byte hex");

    const creatorScript = wallet.payments.scriptBuffer;
    const tokenId = computeTokenId({
      chainIdentity: this.config.chainIdentity,
      policyVersion: 3,
      ticker: canonicalTicker(params.ticker),
      tokenNonce: Buffer.from(params.nonceHex, "hex"),
      creatorScript,
    }).toString("hex");
    this.assertCanaryAllowed({ tokenId, walletScript: params.walletScript });
    await this.requireHealthy();

    const { inputs: deployerInputs, minerFeeSats } =
      await this.resolveFundingAndFee({
        op: "DEPLOY",
        wallet,
        candidates: params.funding,
        targetSats: RESERVE_ANCHOR_SATS + CREATOR_RECORD_SATS + LAUNCH_FEE_SATS,
        feeRateSatPerVb: params.feeRateSatPerVb,
        explicitMinerFeeSats: params.minerFeeSats,
      });
    const result = buildDeployPsbtV3({
      network: btcNetwork(this.config.network),
      identity: {
        chainIdentity: this.config.chainIdentity,
        policyVersion: 3,
        ticker: canonicalTicker(params.ticker),
        tokenNonce: Buffer.from(params.nonceHex, "hex"),
      },
      guardianXOnly: this.config.guardianXOnly,
      recoveryKeyXOnly: this.config.recoveryKeyXOnly,
      recoveryProfile: this.config.recoveryProfile,
      deployerInputs,
      deployerChangeScript: wallet.payments.scriptBuffer,
      creatorScript,
      feeScript: this.config.feeScript,
      minerFeeSats,
    });
    const psbtBase64 = result.psbt.toBase64();
    const digest = unsignedTxDigest(result.psbt);
    const session = await createTxSession(this.db, {
      network: this.config.network,
      operation: "DEPLOY",
      tokenId,
      walletScript: params.walletScript,
      walletAddress: params.walletAddress,
      stateHash: null,
      backingTxid: null,
      backingVout: null,
      unsignedTxDigest: digest,
      psbtBase64,
      metadataJson,
      status: "BUILT",
      expiresAtHeight: null,
      idempotencyKey: params.idempotencyKey,
    });
    return {
      sessionId: session.id,
      psbtBase64,
      tokenId,
      intent: {
        operation: "DEPLOY",
        tokenId,
        tokenAmountAtoms: 0n,
        grossSats: null,

        protocolFeeSats: LAUNCH_FEE_SATS,
        minerFeeSats: result.minerFeeSats,
        netSats: null,
        walletScript: wallet.payments.script,
        ordinalsScript: wallet.ordinals.script,
        stateHash: null,
        unsignedTxDigest: digest,
        walletDeltaSats: walletDeltaSats(result.psbt, wallet.scripts),
      },
    };
  }

  async submitLaunch(params: {
    sessionId: string;
    signedPsbtBase64: string;
  }): Promise<{ txid: string }> {
    this.assertMutating();
    const session = await requireTxSession(this.db, params.sessionId);
    if (session.network !== this.config.network)
      throw new AppError("WRONG_NETWORK", "session belongs to another network");
    this.assertCanaryAllowed({
      tokenId: session.tokenId ?? undefined,
      walletScript: session.walletScript,
    });
    if (session.operation !== "DEPLOY")
      throw new AppError("SESSION_STATE_INVALID", "session is not DEPLOY");
    if (session.status === "BROADCAST" || session.status === "CONFIRMED") {
      if (session.metadataJson && session.tokenId && session.txid) {
        await upsertTokenMetadata({
          db: this.db,
          network: this.config.network,
          tokenId: session.tokenId,
          submittedByScript: session.walletScript,
          deployTxid: session.txid,
          metadata: session.metadataJson,
        });
      }
      return { txid: session.txid! };
    }
    const started = await this.beginSessionSubmission(
      session,
      params.signedPsbtBase64,
    );
    if ("txid" in started) {
      if (session.metadataJson && session.tokenId)
        await upsertTokenMetadata({
          db: this.db,
          network: this.config.network,
          tokenId: session.tokenId,
          submittedByScript: session.walletScript,
          deployTxid: started.txid,
          metadata: session.metadataJson,
        });
      return started;
    }
    const { job, psbt } = started;
    try {
      if (unsignedTxDigest(psbt) !== session.unsignedTxDigest)
        throw new AppError("PSBT_MUTATED", "unsigned tx digest changed");
      for (let i = 0; i < psbt.data.inputs.length; i++)
        validateInputSignature(psbt, i);
      psbt.finalizeAllInputs();
      const rawTxHex = psbt.extractTransaction().toHex();
      const validated = validateFinalizedDeployTransaction({
        rawTxHex,
        network: this.config.network,
        chainIdentity: this.config.chainIdentity,
        guardianXOnly: this.config.guardianXOnly,
        recoveryKeyXOnly: this.config.recoveryKeyXOnly,
        recoveryProfile: this.config.recoveryProfile,
        feeScript: this.config.feeScript,
      });
      if (!("rawTxHex" in validated))
        throw new AppError("GUARDIAN_REJECTED", validated.reason);
      const receipt = await this.broadcastSubmission(job, validated);
      const txid = receipt.txid;
      if (session.metadataJson && session.tokenId) {
        await upsertTokenMetadata({
          db: this.db,
          network: this.config.network,
          tokenId: session.tokenId,
          submittedByScript: session.walletScript,
          deployTxid: txid,
          metadata: session.metadataJson,
        });
      }
      return receipt;
    } catch (error) {
      if (
        error instanceof AppError &&
        [
          "GUARDIAN_REJECTED",
          "STATE_CHANGED",
          "PSBT_MUTATED",
          "WALLET_SIGNATURE_INVALID",
        ].includes(error.code)
      ) {
        await haltSubmission(this.db, job).catch(() => {});
      }
      throw this.submissionError(error);
    } finally {
      await deferSubmission(this.db, job).catch(() => {});
    }
  }

  mintLimits(): {
    maxMintAtoms: bigint;
    maxGrossSats: bigint | null;
    minGrossSats: bigint;
  } {
    return (
      this.config.mintLimits ?? {
        maxMintAtoms: DEV_RISK_POLICY.maxMintAtoms,
        maxGrossSats: DEV_RISK_POLICY.maxGrossSats,
        minGrossSats: DEV_RISK_POLICY.minMintGrossSats,
      }
    );
  }

  async quoteBuyForSats(
    tokenId: string,
    budgetSats: bigint,
  ): Promise<{
    amountAtoms: bigint;
    grossSats: bigint;
    feeSats: bigint;

    creatorFeeSats: bigint;
    carrierSats: bigint;
    totalSats: bigint;

    limitedBy: "budget" | "per-mint limit" | "supply";
    minGrossSats: bigint;
    maxGrossSats: bigint | null;

    minSpendSats: bigint | null;
  }> {
    const backing = await this.loadQuoteBacking(tokenId);
    const supplyTokens =
      backing.state.issuedPublicSupplyAtoms / ATOMS_PER_TOKEN;
    const remaining =
      (PUBLIC_SUPPLY_ATOMS - backing.state.issuedPublicSupplyAtoms) /
      ATOMS_PER_TOKEN;
    const costOf = (n: bigint) => {
      const gross = grossBuy(supplyTokens, n);
      const fee = mintFeeSats(
        gross,
        n * ATOMS_PER_TOKEN,
        this.config.buyFeeBps,
        this.config.buyFeeFlatSats,
      );
      const creator = creatorFeeSats(gross);
      return {
        gross,
        fee,
        creator,
        total: gross + fee + creator + TOKEN_CARRIER_SATS,
      };
    };
    const limits = this.mintLimits();

    const perMintLots = limits.maxMintAtoms / ATOMS_PER_TOKEN / LOT_TOKENS;
    const remainingLots = remaining / LOT_TOKENS;
    const fits = (lots: bigint) => {
      const c = costOf(lots * LOT_TOKENS);
      return (
        c.total <= budgetSats &&
        (limits.maxGrossSats === null || c.gross <= limits.maxGrossSats)
      );
    };

    let loLots = 0n;
    let hiLots = remainingLots < perMintLots ? remainingLots : perMintLots;
    while (loLots < hiLots) {
      const mid = (loLots + hiLots + 1n) / 2n;
      if (fits(mid)) loLots = mid;
      else hiLots = mid - 1n;
    }
    const lo = loLots * LOT_TOKENS;
    const perMintTokens = perMintLots * LOT_TOKENS;

    let minSpendSats: bigint | null = null;
    if (remainingLots > 0n) {
      let a = 1n;
      let b = remainingLots;
      while (a < b) {
        const m = (a + b) / 2n;
        if (costOf(m * LOT_TOKENS).gross >= limits.minGrossSats) b = m;
        else a = m + 1n;
      }
      if (costOf(a * LOT_TOKENS).gross >= limits.minGrossSats)
        minSpendSats = costOf(a * LOT_TOKENS).total;
    }
    const base = {
      carrierSats: TOKEN_CARRIER_SATS,
      minGrossSats: limits.minGrossSats,
      maxGrossSats: limits.maxGrossSats,
      minSpendSats,
    } as const;
    const nothing = {
      ...base,
      amountAtoms: 0n,
      grossSats: 0n,
      feeSats: 0n,
      creatorFeeSats: 0n,
      totalSats: 0n,
      limitedBy: "budget",
    } as const;

    if (lo === 0n) return nothing;
    const c = costOf(lo);
    if (c.gross < limits.minGrossSats) return nothing;
    const next = lo < remaining ? costOf(lo + LOT_TOKENS) : null;
    const limitedBy =
      lo === remaining
        ? "supply"
        : lo === perMintTokens || (next !== null && next.total <= budgetSats)
          ? "per-mint limit"
          : "budget";
    return {
      ...base,
      limitedBy,
      amountAtoms: lo * ATOMS_PER_TOKEN,
      grossSats: c.gross,
      feeSats: c.fee,
      creatorFeeSats: c.creator,
      totalSats: c.total,
    };
  }

  async quoteBackingBuy(
    tokenId: string,
    amountAtoms: bigint,
  ): Promise<BackingQuote> {
    if (
      amountAtoms <= 0n ||
      amountAtoms % (LOT_TOKENS * ATOMS_PER_TOKEN) !== 0n
    )
      throw new AppError(
        "TOKEN_AMOUNT_INVALID",
        "backing buy requires whole 1,000-token lots",
      );
    const backing = await this.loadQuoteBacking(tokenId);
    const supply = backing.state.issuedPublicSupplyAtoms;
    if (supply + amountAtoms > PUBLIC_SUPPLY_ATOMS)
      throw new AppError("TOKEN_AMOUNT_INVALID", "exceeds public cap");
    const gross = grossBuy(
      supply / ATOMS_PER_TOKEN,
      amountAtoms / ATOMS_PER_TOKEN,
    );
    const limits = this.mintLimits();
    if (amountAtoms > limits.maxMintAtoms)
      throw new AppError(
        "TOKEN_AMOUNT_INVALID",
        "exceeds the per-mint token limit",
      );
    if (limits.maxGrossSats !== null && gross > limits.maxGrossSats)
      throw new AppError(
        "TOKEN_AMOUNT_INVALID",
        "exceeds the per-mint curve price limit",
      );
    if (gross < limits.minGrossSats)
      throw new AppError(
        "TOKEN_AMOUNT_INVALID",
        "below the minimum mint curve price",
      );
    const fee = mintFeeSats(
      gross,
      amountAtoms,
      this.config.buyFeeBps,
      this.config.buyFeeFlatSats,
    );
    const next = applyMintV2(backing.state, amountAtoms).nextState;
    return {
      tokenId,
      amountAtoms,
      stateHash: backing.stateHash,
      backingOutpoint: { txid: backing.input.txid, vout: backing.input.vout },
      supplyBeforeAtoms: supply,
      supplyAfterAtoms: next.issuedPublicSupplyAtoms,
      backingBeforeSats: backing.state.backingSats,
      backingAfterSats: next.backingSats,
      grossSats: gross,
      feeSats: fee,
      creatorFeeSats: creatorFeeSats(gross),
      feeBps: this.config.buyFeeBps,
      indexedHeight: backing.indexedHeight,
      indexedBlockHash: backing.indexedBlockHash,
      expiresAtHeight: backing.indexedHeight + 2n,
    };
  }

  async buildBackingBuy(params: {
    tokenId: string;
    amountAtoms: bigint;
    quoteBinding: {
      stateHash: string;
      backingOutpoint: { txid: string; vout: number };
      expiresAtHeight: bigint | null;
    };
    walletScript: string;

    ordinalsScript?: string;
    walletPublicKey?: string;
    ordinalsPublicKey?: string;
    walletAddress: string | null;
    funding: FundingCandidate[];

    feeRateSatPerVb?: bigint;

    minerFeeSats?: bigint;
    idempotencyKey: string;
  }): Promise<{ sessionId: string; psbtBase64: string; intent: IntentV3 }> {
    this.assertMutating();
    this.validateTokenAmount(
      params.tokenId,
      params.amountAtoms,
      LOT_TOKENS * ATOMS_PER_TOKEN,
    );
    if (params.amountAtoms > this.mintLimits().maxMintAtoms)
      throw new AppError(
        "TOKEN_AMOUNT_INVALID",
        "exceeds the per-mint token limit",
      );
    this.assertCanaryAllowed({
      tokenId: params.tokenId,
      walletScript: params.walletScript,
    });
    const wallet = resolveWalletIdentity(walletIdentityFrom(params));
    validateFundingCandidates(params.funding);
    const binding = params.quoteBinding;
    if (
      !binding ||
      !/^[0-9a-f]{64}$/i.test(binding.stateHash) ||
      !binding.backingOutpoint ||
      !/^[0-9a-f]{64}$/i.test(binding.backingOutpoint.txid) ||
      binding.backingOutpoint.vout !== 1 ||
      (binding.expiresAtHeight !== null &&
        (typeof binding.expiresAtHeight !== "bigint" ||
          binding.expiresAtHeight < 0n))
    )
      throw new AppError("QUOTE_STALE", "invalid quote binding");
    const backing = await this.loadQuoteBacking(params.tokenId);
    const cachedFunding = await resolveCachedFundingUtxos(
      this.db,
      this.config.network,
      wallet.payments.script,
      params.funding,
    );
    if (
      backing.stateHash !== params.quoteBinding.stateHash ||
      backing.input.txid !== params.quoteBinding.backingOutpoint.txid ||
      backing.input.vout !== params.quoteBinding.backingOutpoint.vout
    ) {
      throw new AppError("QUOTE_STALE", "backing state changed since quote");
    }

    const discoveryTicker = this.config.discoveryEnvelope
      ? (await getV3TokenDetail(this.db, this.config.network, params.tokenId))
          ?.ticker
      : undefined;

    const { grossSats: quotedGrossSats } = applyMintV2(
      backing.state,
      params.amountAtoms,
    );
    const quotedBuyFeeSats = mintFeeSats(
      quotedGrossSats,
      params.amountAtoms,
      this.config.buyFeeBps,
      this.config.buyFeeFlatSats,
    );
    const creatorScript = await this.creatorScriptOf(params.tokenId);
    const quotedCreatorFeeSats = creatorFeeSats(quotedGrossSats);
    const { inputs: buyerInputs, minerFeeSats } =
      await this.resolveFundingAndFee({
        op: "BACKING_BUY",
        cachedFunding,
        wallet,
        candidates: params.funding,
        targetSats:
          quotedGrossSats +
          quotedBuyFeeSats +
          quotedCreatorFeeSats +
          TOKEN_CARRIER_SATS,
        discovery: discoveryTicker !== undefined,
        feeRateSatPerVb: params.feeRateSatPerVb,
        explicitMinerFeeSats: params.minerFeeSats,
      });
    const result = buildMintPsbtV3({
      network: btcNetwork(this.config.network),
      tokenId: Buffer.from(params.tokenId, "hex"),
      prevState: backing.state,
      prevBacking: backing.input,
      mintAmountAtoms: params.amountAtoms,
      guardianXOnly: this.config.guardianXOnly,
      recoveryKeyXOnly: this.config.recoveryKeyXOnly,
      recoveryProfile: this.config.recoveryProfile,
      buyerInputs,

      buyerCarrierScript: wallet.ordinals.scriptBuffer,
      buyerChangeScript: wallet.payments.scriptBuffer,
      feeScript: this.config.feeScript,
      creatorScript,
      minerFeeSats,
      buyFeeBps: this.config.buyFeeBps,
      buyFeeFlatSats: this.config.buyFeeFlatSats,
      discoveryEnvelope: discoveryTicker
        ? { ticker: discoveryTicker }
        : undefined,
    });
    const view = this.overlayPendingBacking(
      await this.loadView(params.tokenId),
      params.tokenId,
      backing,
    );
    const req: TransitionSignRequest = {
      psbt: result.psbt,
      view,
      network: this.config.network,
      recoveryKeyXOnly: this.config.recoveryKeyXOnly,
      recoveryProfile: this.config.recoveryProfile,
      feeScript: this.config.feeScript,
      maxMinerFeeSats: this.config.maxMinerFeeSats,
      buyFeeBps: this.config.buyFeeBps,
      buyFeeFlatSats: this.config.buyFeeFlatSats,
      discoveryTicker,
      fundingChecker: cachedBuildFundingChecker(cachedFunding),
    };
    const checked = await validateMintTransitionV3({
      ...req,
      guardianXOnly: this.config.guardianXOnly,
    });
    if (!checked.ok)
      throw new AppError(
        "GUARDIAN_REJECTED",
        `${checked.reason}: ${checked.detail}`,
      );
    const psbtBase64 = result.psbt.toBase64();
    const digest = unsignedTxDigest(result.psbt);
    const session = await createTxSession(this.db, {
      network: this.config.network,
      operation: "BACKING_BUY",
      tokenId: params.tokenId,
      walletScript: params.walletScript,
      walletAddress: params.walletAddress,
      stateHash: backing.stateHash,
      backingTxid: backing.input.txid,
      backingVout: backing.input.vout,
      unsignedTxDigest: digest,
      psbtBase64,
      status: "BUILT",
      expiresAtHeight: params.quoteBinding.expiresAtHeight,
      idempotencyKey: params.idempotencyKey,
    });
    return {
      sessionId: session.id,
      psbtBase64,
      intent: {
        operation: "BACKING_BUY",
        tokenId: params.tokenId,
        tokenAmountAtoms: params.amountAtoms,
        grossSats: result.grossSats,
        protocolFeeSats: result.buyFeeSats,
        creatorFeeSats: result.creatorFeeSats,
        creatorScript: creatorScript.toString("hex"),
        minerFeeSats: result.minerFeeSats,
        netSats: null,
        walletScript: wallet.payments.script,
        ordinalsScript: wallet.ordinals.script,
        stateHash: backing.stateHash,
        unsignedTxDigest: digest,
        walletDeltaSats: walletDeltaSats(result.psbt, wallet.scripts),
      },
    };
  }

  async submitBackingBuy(params: {
    sessionId: string;
    signedPsbtBase64: string;
  }): Promise<{ txid: string }> {
    this.assertMutating();
    const session = await requireTxSession(this.db, params.sessionId);
    if (session.network !== this.config.network)
      throw new AppError("WRONG_NETWORK", "session belongs to another network");
    this.assertCanaryAllowed({
      tokenId: session.tokenId ?? undefined,
      walletScript: session.walletScript,
    });
    if (session.operation !== "BACKING_BUY")
      throw new AppError("SESSION_STATE_INVALID", "session is not BACKING_BUY");
    if (session.status === "BROADCAST" || session.status === "CONFIRMED")
      return { txid: session.txid! };
    const started = await this.beginSessionSubmission(
      session,
      params.signedPsbtBase64,
    );
    if ("txid" in started) return started;
    const { job, psbt } = started;
    try {
      if (unsignedTxDigest(psbt) !== session.unsignedTxDigest)
        throw new AppError("PSBT_MUTATED", "unsigned tx digest changed");
      for (let i = 1; i < psbt.data.inputs.length; i++) {
        validateInputSignature(psbt, i);
        psbt.finalizeInput(i);
      }
      const backing = await this.loadBackingAt(
        session.tokenId!,
        session.backingTxid,
        session.backingVout,
      );
      const view = this.overlayPendingBacking(
        await this.loadView(session.tokenId!),
        session.tokenId!,
        backing,
      );
      const discoveryTicker = this.config.discoveryEnvelope
        ? (
            await getV3TokenDetail(
              this.db,
              this.config.network,
              session.tokenId!,
            )
          )?.ticker
        : undefined;
      const signed = await this.transitionSigner.signMint({
        psbt,
        view,
        network: this.config.network,
        recoveryKeyXOnly: this.config.recoveryKeyXOnly,
        recoveryProfile: this.config.recoveryProfile,
        feeScript: this.config.feeScript,
        maxMinerFeeSats: this.config.maxMinerFeeSats,
        buyFeeBps: this.config.buyFeeBps,
        buyFeeFlatSats: this.config.buyFeeFlatSats,
        discoveryTicker,
        fundingChecker: this.createFundingChecker(backing.chainObservation),
      });
      if (!signed.ok) {
        const transient = [
          "GUARDIAN_TIMEOUT",
          "REMOTE_GUARDIAN_UNAVAILABLE",
          "FUNDING_CHECK_UNAVAILABLE",
          "AUDIT_PERSISTENCE_FAILED",
          "SIGNING_FAILED",
        ].includes(signed.reason);
        throw new AppError(
          transient ? "CORE_UNAVAILABLE" : "GUARDIAN_REJECTED",
          `${signed.reason}: ${signed.detail}`,
        );
      }
      const rawTxHex = psbt.extractTransaction().toHex();
      const validated = await validateFinalizedMintTransaction({
        rawTxHex,
        view,
        network: this.config.network,
        guardianXOnly: this.config.guardianXOnly,
        recoveryKeyXOnly: this.config.recoveryKeyXOnly,
        recoveryProfile: this.config.recoveryProfile,
        feeScript: this.config.feeScript,
        maxMinerFeeSats: this.config.maxMinerFeeSats,
        buyFeeBps: this.config.buyFeeBps,
        buyFeeFlatSats: this.config.buyFeeFlatSats,
      });
      if (!("rawTxHex" in validated))
        throw new AppError("GUARDIAN_REJECTED", validated.reason);
      const receipt = await this.broadcastSubmission(job, validated);
      return receipt;
    } catch (error) {
      if (
        error instanceof AppError &&
        [
          "GUARDIAN_REJECTED",
          "STATE_CHANGED",
          "PSBT_MUTATED",
          "WALLET_SIGNATURE_INVALID",
        ].includes(error.code)
      ) {
        await haltSubmission(this.db, job).catch(() => {});
      }
      throw this.submissionError(error);
    } finally {
      await deferSubmission(this.db, job).catch(() => {});
    }
  }

  async quoteRedeem(
    tokenId: string,
    amountAtoms: bigint,
  ): Promise<RedeemQuote> {
    this.validateTokenAmount(
      tokenId,
      amountAtoms,
      LOT_TOKENS * ATOMS_PER_TOKEN,
    );
    const backing = await this.loadQuoteBacking(tokenId);
    const gross = grossRedeem(
      backing.state.issuedPublicSupplyAtoms / ATOMS_PER_TOKEN,
      amountAtoms / ATOMS_PER_TOKEN,
    );
    const fee = redeemFeeSats(
      gross,
      this.config.redeemFeeBps,
      this.config.redeemFeeFlatSats,
    );
    const next = applyRedeemV2(backing.state, amountAtoms).nextState;
    return {
      tokenId,
      amountAtoms,
      stateHash: backing.stateHash,
      backingOutpoint: { txid: backing.input.txid, vout: backing.input.vout },
      supplyBeforeAtoms: backing.state.issuedPublicSupplyAtoms,
      supplyAfterAtoms: next.issuedPublicSupplyAtoms,
      backingBeforeSats: backing.state.backingSats,
      backingAfterSats: next.backingSats,
      grossSats: gross,
      feeSats: fee,
      netSats: gross - fee,
    };
  }

  async buildRedeem(params: {
    tokenId: string;
    amountAtoms: bigint;
    walletScript: string;

    ordinalsScript?: string;
    walletPublicKey?: string;
    ordinalsPublicKey?: string;
    walletAddress: string | null;

    feeRateSatPerVb?: bigint;

    minerFeeSats?: bigint;
    idempotencyKey: string;

    funding?: FundingCandidate[];
  }): Promise<{ sessionId: string; psbtBase64: string; intent: IntentV3 }> {
    this.assertMutating();
    this.validateTokenAmount(
      params.tokenId,
      params.amountAtoms,
      LOT_TOKENS * ATOMS_PER_TOKEN,
    );
    this.assertCanaryAllowed({
      tokenId: params.tokenId,
      walletScript: params.walletScript,
    });
    const wallet = resolveWalletIdentity(walletIdentityFrom(params));
    validateFundingCandidates(params.funding ?? []);
    await this.loadConfirmedBacking(params.tokenId);

    const tokenUtxos = await getTokenUtxosByScriptDb(
      this.db,
      this.config.network,
      wallet.ordinals.script,
    );
    const mine = tokenUtxos.filter((u) => u.tokenId === params.tokenId);
    const total = mine.reduce((s, u) => s + u.amountAtoms, 0n);
    if (total < params.amountAtoms)
      throw new AppError("TOKEN_AMOUNT_INVALID", "insufficient token balance");

    const sorted = [...mine].sort((a, b) =>
      a.amountAtoms !== b.amountAtoms
        ? a.amountAtoms > b.amountAtoms
          ? -1
          : 1
        : a.txid < b.txid
          ? -1
          : 1,
    );
    const selected: typeof sorted = [];
    let running = 0n;
    for (const u of sorted) {
      if (running >= params.amountAtoms) break;
      selected.push(u);
      running += u.amountAtoms;
    }
    await this.requireHealthy();
    const backing = await this.loadBacking(params.tokenId);

    const tokenInputs: ResolvedInput[] = selected.map((u) => ({
      txid: u.txid,
      vout: u.vout,
      script: Buffer.from(u.scriptPubKey, "hex"),
      valueSats: TOKEN_CARRIER_SATS,
      publicKey: wallet.ordinals.publicKeyBuffer,
    }));
    const tokenInputTotalAtoms = selected.reduce(
      (s, u) => s + u.amountAtoms,
      0n,
    );
    const grossSats = grossRedeem(
      backing.state.issuedPublicSupplyAtoms / ATOMS_PER_TOKEN,
      params.amountAtoms / ATOMS_PER_TOKEN,
    );
    const protocolFeeSats = redeemFeeSats(
      grossSats,
      this.config.redeemFeeBps,
      this.config.redeemFeeFlatSats,
    );
    const walletFundedFees =
      grossSats - protocolFeeSats < dustThreshold(wallet.payments.scriptBuffer);
    const changeCarrierSats =
      tokenInputTotalAtoms > params.amountAtoms ? TOKEN_CARRIER_SATS : 0n;
    const carrierSatsIn = BigInt(tokenInputs.length) * TOKEN_CARRIER_SATS;
    const { inputs: funderInputs, minerFeeSats } =
      await this.resolveFundingAndFee({
        op: "REDEEM",
        wallet,
        candidates: params.funding ?? [],
        targetSats: walletFundedFees
          ? redeemWalletFundingTarget(
              grossSats,
              protocolFeeSats,
              wallet.payments.scriptBuffer,
              carrierSatsIn,
              changeCarrierSats,
            )
          : changeCarrierSats - carrierSatsIn,
        tokenInputs: tokenInputs.length,
        feeRateSatPerVb: params.feeRateSatPerVb,
        explicitMinerFeeSats: params.minerFeeSats,
      });
    const result = buildRedeemPsbtV3({
      network: btcNetwork(this.config.network),
      tokenId: Buffer.from(params.tokenId, "hex"),
      prevState: backing.state,
      prevBacking: backing.input,
      redeemAmountAtoms: params.amountAtoms,
      tokenInputs,
      tokenInputTotalAtoms,
      guardianXOnly: this.config.guardianXOnly,
      recoveryKeyXOnly: this.config.recoveryKeyXOnly,
      recoveryProfile: this.config.recoveryProfile,
      sellerPayoutScript: wallet.payments.scriptBuffer,

      sellerChangeScript: wallet.ordinals.scriptBuffer,
      feeScript: this.config.feeScript,
      minerFeeSats,
      walletFundedFees,
      funderInputs,
      funderChangeScript: wallet.payments.scriptBuffer,
      redeemFeeBps: this.config.redeemFeeBps,
      redeemFeeFlatSats: this.config.redeemFeeFlatSats,
    });
    const view = this.overlayPendingBacking(
      await this.loadView(
        params.tokenId,
        selected.map((u) => ({ txid: u.txid, vout: u.vout })),
      ),
      params.tokenId,
      backing,
    );
    const req: TransitionSignRequest = {
      psbt: result.psbt,
      view,
      network: this.config.network,
      recoveryKeyXOnly: this.config.recoveryKeyXOnly,
      recoveryProfile: this.config.recoveryProfile,
      feeScript: this.config.feeScript,
      maxMinerFeeSats: this.config.maxMinerFeeSats,
      redeemFeeBps: this.config.redeemFeeBps,
      redeemFeeFlatSats: this.config.redeemFeeFlatSats,
      fundingChecker: this.fundingChecker,
    };

    const checked = await validateRedeemTransitionV3({
      ...req,
      guardianXOnly: this.config.guardianXOnly,
    });
    if (!checked.ok)
      throw new AppError(
        "GUARDIAN_REJECTED",
        `${checked.reason}: ${checked.detail}`,
      );
    const psbtBase64 = result.psbt.toBase64();
    const digest = unsignedTxDigest(result.psbt);
    const session = await createTxSession(this.db, {
      network: this.config.network,
      operation: "REDEEM",
      tokenId: params.tokenId,
      walletScript: params.walletScript,
      walletAddress: params.walletAddress,
      stateHash: backing.stateHash,
      backingTxid: backing.input.txid,
      backingVout: backing.input.vout,
      unsignedTxDigest: digest,
      psbtBase64,
      status: "BUILT",
      expiresAtHeight: null,
      idempotencyKey: params.idempotencyKey,
    });
    return {
      sessionId: session.id,
      psbtBase64,
      intent: {
        operation: "REDEEM",
        tokenId: params.tokenId,
        tokenAmountAtoms: params.amountAtoms,
        grossSats: result.grossSats,
        protocolFeeSats: result.redeemFeeSats,
        minerFeeSats: result.minerFeeSats,
        netSats: result.netSats,
        payoutSats: walletFundedFees ? result.payoutSats : undefined,
        walletScript: wallet.payments.script,
        ordinalsScript: wallet.ordinals.script,
        stateHash: backing.stateHash,
        unsignedTxDigest: digest,
        walletDeltaSats: walletDeltaSats(result.psbt, wallet.scripts),
      },
    };
  }

  async submitRedeem(params: {
    sessionId: string;
    signedPsbtBase64: string;
  }): Promise<{ txid: string }> {
    this.assertMutating();
    const session = await requireTxSession(this.db, params.sessionId);
    if (session.network !== this.config.network)
      throw new AppError("WRONG_NETWORK", "session belongs to another network");
    this.assertCanaryAllowed({
      tokenId: session.tokenId ?? undefined,
      walletScript: session.walletScript,
    });
    if (session.operation !== "REDEEM")
      throw new AppError("SESSION_STATE_INVALID", "session is not REDEEM");
    if (session.status === "BROADCAST" || session.status === "CONFIRMED")
      return { txid: session.txid! };
    const started = await this.beginSessionSubmission(
      session,
      params.signedPsbtBase64,
    );
    if ("txid" in started) return started;
    const { job, psbt } = started;
    try {
      if (unsignedTxDigest(psbt) !== session.unsignedTxDigest)
        throw new AppError("PSBT_MUTATED", "unsigned tx digest changed");
      for (let i = 1; i < psbt.data.inputs.length; i++) {
        validateInputSignature(psbt, i);
        psbt.finalizeInput(i);
      }

      const spent = psbt.txInputs.map((i) => ({
        txid: Buffer.from(i.hash).reverse().toString("hex"),
        vout: i.index,
      }));
      const view = this.overlayPendingBacking(
        await this.loadView(session.tokenId!, spent),
        session.tokenId!,
        await this.loadBackingAt(
          session.tokenId!,
          session.backingTxid,
          session.backingVout,
        ),
      );
      const signed = await this.transitionSigner.signRedeem({
        psbt,
        view,
        network: this.config.network,
        recoveryKeyXOnly: this.config.recoveryKeyXOnly,
        recoveryProfile: this.config.recoveryProfile,
        feeScript: this.config.feeScript,
        maxMinerFeeSats: this.config.maxMinerFeeSats,
        redeemFeeBps: this.config.redeemFeeBps,
        redeemFeeFlatSats: this.config.redeemFeeFlatSats,
        fundingChecker: this.fundingChecker,
      });
      if (!signed.ok) {
        const transient = [
          "GUARDIAN_TIMEOUT",
          "REMOTE_GUARDIAN_UNAVAILABLE",
          "FUNDING_CHECK_UNAVAILABLE",
          "AUDIT_PERSISTENCE_FAILED",
          "SIGNING_FAILED",
        ].includes(signed.reason);
        throw new AppError(
          transient ? "CORE_UNAVAILABLE" : "GUARDIAN_REJECTED",
          `${signed.reason}: ${signed.detail}`,
        );
      }
      const rawTxHex = psbt.extractTransaction().toHex();
      const validated = await validateFinalizedRedeemTransaction({
        rawTxHex,
        view,
        network: this.config.network,
        guardianXOnly: this.config.guardianXOnly,
        recoveryKeyXOnly: this.config.recoveryKeyXOnly,
        recoveryProfile: this.config.recoveryProfile,
        feeScript: this.config.feeScript,
        maxMinerFeeSats: this.config.maxMinerFeeSats,
        redeemFeeBps: this.config.redeemFeeBps,
        redeemFeeFlatSats: this.config.redeemFeeFlatSats,
      });
      if (!("rawTxHex" in validated))
        throw new AppError("GUARDIAN_REJECTED", validated.reason);
      const receipt = await this.broadcastSubmission(job, validated);
      return receipt;
    } catch (error) {
      if (
        error instanceof AppError &&
        [
          "GUARDIAN_REJECTED",
          "STATE_CHANGED",
          "PSBT_MUTATED",
          "WALLET_SIGNATURE_INVALID",
        ].includes(error.code)
      ) {
        await haltSubmission(this.db, job).catch(() => {});
      }
      throw this.submissionError(error);
    } finally {
      await deferSubmission(this.db, job).catch(() => {});
    }
  }

  async buildTransfer(params: {
    tokenId: string;
    amountAtoms: bigint;
    recipientScript: string;
    walletScript: string;

    ordinalsScript?: string;
    walletPublicKey?: string;
    ordinalsPublicKey?: string;
    walletAddress: string | null;
    funding: FundingCandidate[];

    feeRateSatPerVb?: bigint;

    minerFeeSats?: bigint;
    idempotencyKey: string;
  }): Promise<{ sessionId: string; psbtBase64: string; intent: IntentV3 }> {
    this.assertMutating();
    this.validateTokenAmount(params.tokenId, params.amountAtoms);
    const wallet = resolveWalletIdentity(walletIdentityFrom(params));
    validateFundingCandidates(params.funding);
    if (
      !/^(?:0014[0-9a-f]{40}|5120[0-9a-f]{64})$/i.test(params.recipientScript)
    )
      throw new AppError(
        "TOKEN_AMOUNT_INVALID",
        "recipient must be a token carrier script",
      );
    await this.loadConfirmedBacking(params.tokenId);
    const tokenUtxos = await getTokenUtxosByScriptDb(
      this.db,
      this.config.network,
      wallet.ordinals.script,
    );
    const mine = tokenUtxos.filter((u) => u.tokenId === params.tokenId);
    const total = mine.reduce((s, u) => s + u.amountAtoms, 0n);
    if (total < params.amountAtoms)
      throw new AppError("TOKEN_AMOUNT_INVALID", "insufficient token balance");

    const sorted = [...mine].sort((a, b) =>
      a.amountAtoms !== b.amountAtoms
        ? a.amountAtoms > b.amountAtoms
          ? -1
          : 1
        : a.txid < b.txid
          ? -1
          : 1,
    );
    const selected: typeof sorted = [];
    let runningAtoms = 0n;
    for (const u of sorted) {
      if (runningAtoms >= params.amountAtoms) break;
      if (selected.length >= MAX_TRANSFER_TOKEN_INPUTS) break;
      selected.push(u);
      runningAtoms += u.amountAtoms;
    }
    if (runningAtoms < params.amountAtoms) {
      throw new AppError(
        "TOKEN_AMOUNT_INVALID",
        `balance is spread across too many outputs: the ${MAX_TRANSFER_TOKEN_INPUTS} largest hold ` +
          `${runningAtoms} atoms, short of ${params.amountAtoms}. Consolidate with a transfer to ` +
          `yourself, or send a smaller amount.`,
      );
    }
    await this.requireHealthy();

    const tokenInputs: ResolvedInput[] = selected.map((u) => ({
      txid: u.txid,
      vout: u.vout,
      script: Buffer.from(u.scriptPubKey, "hex"),
      valueSats: TOKEN_CARRIER_SATS,
      publicKey: wallet.ordinals.publicKeyBuffer,
    }));
    const tokenInputTotalAtoms = selected.reduce(
      (s, u) => s + u.amountAtoms,
      0n,
    );
    const changeAtoms = tokenInputTotalAtoms - params.amountAtoms;
    const tokenOutputs: { script: Buffer; amountAtoms: bigint }[] = [
      {
        script: Buffer.from(params.recipientScript, "hex"),
        amountAtoms: params.amountAtoms,
      },
    ];
    if (changeAtoms > 0n)
      tokenOutputs.push({
        script: wallet.ordinals.scriptBuffer,
        amountAtoms: changeAtoms,
      });

    const carrierSatsOut = BigInt(tokenOutputs.length) * TOKEN_CARRIER_SATS;
    const carrierSatsIn = BigInt(tokenInputs.length) * TOKEN_CARRIER_SATS;
    const { inputs: funderInputs, minerFeeSats } =
      await this.resolveFundingAndFee({
        op: "TRANSFER",
        wallet,
        candidates: params.funding,
        targetSats: carrierSatsOut - carrierSatsIn,
        tokenInputs: tokenInputs.length,
        recipientCarriers: tokenOutputs.length,
        feeRateSatPerVb: params.feeRateSatPerVb,
        explicitMinerFeeSats: params.minerFeeSats,
      });
    const result = buildTransferPsbtV2({
      network: btcNetwork(this.config.network),
      tokenId: Buffer.from(params.tokenId, "hex"),
      tokenInputs,
      tokenInputTotalAtoms,
      tokenOutputs,
      funderInputs,
      funderChangeScript: wallet.payments.scriptBuffer,
      btcOutputs: [],
      minerFeeSats,
    });
    const psbtBase64 = result.psbt.toBase64();
    const digest = unsignedTxDigest(result.psbt);
    const session = await createTxSession(this.db, {
      network: this.config.network,
      operation: "TRANSFER",
      tokenId: params.tokenId,
      walletScript: params.walletScript,
      walletAddress: params.walletAddress,
      stateHash: null,
      backingTxid: null,
      backingVout: null,
      unsignedTxDigest: digest,
      psbtBase64,
      status: "BUILT",
      expiresAtHeight: null,
      idempotencyKey: params.idempotencyKey,
    });
    return {
      sessionId: session.id,
      psbtBase64,
      intent: {
        operation: "TRANSFER",
        tokenId: params.tokenId,
        tokenAmountAtoms: params.amountAtoms,
        grossSats: null,
        protocolFeeSats: null,
        minerFeeSats: result.minerFeeSats,
        netSats: null,
        walletScript: wallet.payments.script,
        ordinalsScript: wallet.ordinals.script,
        stateHash: null,
        unsignedTxDigest: digest,
        walletDeltaSats: walletDeltaSats(result.psbt, wallet.scripts),
      },
    };
  }

  async submitTransfer(params: {
    sessionId: string;
    signedPsbtBase64: string;
  }): Promise<{ txid: string }> {
    this.assertMutating();
    const session = await requireTxSession(this.db, params.sessionId);
    if (session.network !== this.config.network)
      throw new AppError("WRONG_NETWORK", "session belongs to another network");
    this.assertCanaryAllowed({
      tokenId: session.tokenId ?? undefined,
      walletScript: session.walletScript,
    });
    if (session.operation !== "TRANSFER")
      throw new AppError("SESSION_STATE_INVALID", "session is not TRANSFER");
    if (session.status === "BROADCAST" || session.status === "CONFIRMED")
      return { txid: session.txid! };
    const started = await this.beginSessionSubmission(
      session,
      params.signedPsbtBase64,
    );
    if ("txid" in started) return started;
    const { job, psbt } = started;
    try {
      if (unsignedTxDigest(psbt) !== session.unsignedTxDigest)
        throw new AppError("PSBT_MUTATED", "unsigned tx digest changed");
      for (let i = 0; i < psbt.data.inputs.length; i++)
        validateInputSignature(psbt, i);
      psbt.finalizeAllInputs();
      const rawTxHex = psbt.extractTransaction().toHex();
      const view = this.overlayPendingBacking(
        await this.loadView(
          session.tokenId!,
          psbt.txInputs.map((i) => ({
            txid: Buffer.from(i.hash).reverse().toString("hex"),
            vout: i.index,
          })),
        ),
        session.tokenId!,
        await this.loadBackingAt(
          session.tokenId!,
          session.backingTxid,
          session.backingVout,
        ),
      );
      const validated = validateFinalizedTransferTransaction({
        rawTxHex,
        view,
        maxMinerFeeSats: this.config.maxMinerFeeSats,
      });
      if (!("rawTxHex" in validated))
        throw new AppError("GUARDIAN_REJECTED", validated.reason);
      const receipt = await this.broadcastSubmission(job, validated);
      return receipt;
    } catch (error) {
      if (
        error instanceof AppError &&
        [
          "GUARDIAN_REJECTED",
          "STATE_CHANGED",
          "PSBT_MUTATED",
          "WALLET_SIGNATURE_INVALID",
        ].includes(error.code)
      ) {
        await haltSubmission(this.db, job).catch(() => {});
      }
      throw this.submissionError(error);
    } finally {
      await deferSubmission(this.db, job).catch(() => {});
    }
  }

  async txStatus(txid: string) {
    const result = await this.db
      .execute(sql`select s.status as session_status, e.block_height::text as confirmed_height,
      e.block_hash as confirmed_hash, e.created_at as confirmed_at, o.state as observed_state, o.observed_at,
      (${indexedBackingConflictQuery(this.config.network, txid)}) as conflict,
      (o.chain_generation = g.chain_generation and not c.rebuilding and r.core_reachable
        and r.core_height = c.height and r.core_tip = c.block_hash and r.chain_observed_at >= clock_timestamp() - interval '30 seconds'
        and o.observed_at >= clock_timestamp() - interval '15 seconds') as fresh
      from (select ${this.config.network}::text as network, ${txid}::text as txid) q
      left join lateral (select status from cove_v3_app_transactions where network = q.network and txid = q.txid limit 1) s on true
      left join lateral (select block_height, block_hash, created_at from cove_v3_events where network = q.network and txid = q.txid and canonical and valid limit 1) e on true
      left join cove_transaction_observations o on o.network = q.network and o.txid = q.txid
      left join cove_observation_epochs g on g.network = q.network
      left join cove_v3_cursor c on c.network = q.network
      left join cove_v3_runtime r on r.network = q.network`);
    const row = result.rows[0];
    const confirmedHeight =
      row?.confirmed_height == null
        ? null
        : BigInt(String(row.confirmed_height));
    const session = row?.session_status
      ? {
          status:
            row.session_status === "CONFIRMED" && confirmedHeight === null
              ? "REORGED"
              : String(row.session_status),
        }
      : null;
    const unknown = {
      txid,
      session,
      state: "unknown" as string,
      mempool: null as boolean | null,
      confirmedHeight: null as bigint | null,
      confirmedBlockHash: null as string | null,
      observedAt: null as string | null,
      stale: true,
    };
    if (confirmedHeight !== null)
      return {
        ...unknown,
        state: "confirmed",
        mempool: false,
        confirmedHeight,
        confirmedBlockHash: String(row!.confirmed_hash),
        observedAt: databaseDate(row!.confirmed_at)?.toISOString() ?? null,
        stale: false,
      };
    if (row?.conflict === true)
      return {
        ...unknown,
        session: session ? { status: "CONFLICTED" } : null,
        state: "conflicted",
        mempool: false,
        stale: false,
      };
    if (row?.fresh !== true) return unknown;
    return {
      ...unknown,
      state: row.observed_state === "pending" ? "pending" : "unknown",
      mempool: row.observed_state === "pending" ? true : null,
      observedAt: databaseDate(row.observed_at)?.toISOString() ?? null,
      stale: false,
    };
  }

  async reconcileAppSessions(): Promise<{ confirmed: number }> {
    return this.db.transaction(async (tx) => {
      const confirmed =
        await tx.execute(sql`update cove_v3_app_transactions s set status = 'CONFIRMED', updated_at = clock_timestamp()
        where s.network = ${this.config.network} and s.id in (
          select p.id from cove_v3_app_transactions p where p.network = ${this.config.network}
          and p.status in ('BROADCAST','REORGED') and exists (
            select 1 from cove_v3_events e where e.network = p.network and e.txid = p.txid and e.canonical and e.valid) limit 200)
        and s.status in ('BROADCAST','REORGED') returning s.id`);
      await tx.execute(sql`update cove_v3_app_transactions s set status = 'REORGED', updated_at = clock_timestamp()
        where s.network = ${this.config.network} and s.id in (
          select p.id from cove_v3_app_transactions p where p.network = ${this.config.network} and p.status = 'CONFIRMED'
          and not exists (select 1 from cove_v3_events e where e.network = p.network and e.txid = p.txid and e.canonical and e.valid)
          and exists (select 1 from cove_v3_cursor c where c.network = p.network and not c.rebuilding) limit 200)
        and s.status = 'CONFIRMED'`);
      return { confirmed: confirmed.rows.length };
    });
  }

  async prepareListing(params: {
    tokenId: string;
    sourceTxid: string;
    sourceVout: number;
    amountAtoms: bigint;
    totalPriceSats: bigint;

    expiryBlocks?: bigint;

    expiryHeight?: bigint;
    walletScript: string;

    ordinalsScript?: string;
    walletPublicKey?: string;
    ordinalsPublicKey?: string;
    nonceHex: string;
  }): Promise<{
    listing: ListingV1;
    listingId: string;
    listingPsbtBase64: string;
    expiryHeight: bigint;
  }> {
    this.assertEnabled();
    const wallet = resolveWalletIdentity(walletIdentityFrom(params));
    const utxoRows = await this.db
      .select()
      .from(schema.coveV3TokenUtxos)
      .where(
        and(
          eq(schema.coveV3TokenUtxos.network, this.config.network),
          eq(schema.coveV3TokenUtxos.txid, params.sourceTxid),
          eq(schema.coveV3TokenUtxos.vout, params.sourceVout),
          eq(schema.coveV3TokenUtxos.tokenId, params.tokenId),
          eq(schema.coveV3TokenUtxos.scriptPubKey, wallet.ordinals.script),
          eq(schema.coveV3TokenUtxos.canonical, true),
          isNull(schema.coveV3TokenUtxos.spentByTxid),
        ),
      );

    const u = utxoRows[0];
    if (u && u.amountAtoms !== params.amountAtoms) {
      throw new AppError(
        "TOKEN_AMOUNT_INVALID",
        "a listing sells a whole token carrier; split off the amount first",
      );
    }
    const sourceAmountAtoms = u ? u.amountAtoms : params.amountAtoms;
    const cursor = await this.db
      .select()
      .from(schema.coveV3Cursor)
      .where(eq(schema.coveV3Cursor.network, this.config.network));
    const tip = cursor[0]?.height ?? 0n;
    const nonce = Buffer.from(params.nonceHex, "hex");
    if (nonce.length !== 32)
      throw new AppError("TOKEN_AMOUNT_INVALID", "nonce must be 32 bytes");

    const expiryHeight =
      params.expiryBlocks !== undefined && params.expiryBlocks > 0n
        ? tip + params.expiryBlocks
        : (params.expiryHeight ?? tip + DEFAULT_LISTING_BLOCKS);
    if (expiryHeight <= tip) {
      throw new AppError(
        "TOKEN_AMOUNT_INVALID",
        "listing would already be expired",
      );
    }
    if (expiryHeight - tip > this.config.maxListingBlocks) {
      throw new AppError(
        "TOKEN_AMOUNT_INVALID",
        `a listing may stay open for at most ${this.config.maxListingBlocks} blocks ` +
          `(about ${this.config.maxListingBlocks / 144n} days)`,
      );
    }
    const listing: ListingV1 = {
      orderVersion: 1,
      chainIdentity: this.config.chainIdentity,
      tokenId: params.tokenId,

      sellerTokenScript: wallet.ordinals.script,
      sellerPayoutScript: wallet.payments.script,
      sellerTokenChangeScript: wallet.ordinals.script,
      sourceTxid: params.sourceTxid,
      sourceVout: params.sourceVout,
      sourceAmountAtoms,
      amountAtoms: sourceAmountAtoms,
      totalPriceSats: params.totalPriceSats,
      creationHeight: tip,
      expiryHeight,
      nonce: nonce.toString("hex"),
    };
    const listingId = listingIdOf(listing);

    const listingPsbtBase64 = await this.market.buildListingPsbtFor(
      listing,
      wallet.ordinals.publicKey || undefined,
    );
    return { listing, listingId, listingPsbtBase64, expiryHeight };
  }

  createListing(
    listing: ListingV1,
    presignedPsbtBase64: string,
    sellerTokenPublicKey?: string,
  ) {
    this.assertMutating();
    this.assertCanaryAllowed({
      tokenId: listing.tokenId,
      walletScript: listing.sellerPayoutScript,
    });
    return this.market.createListing({
      ...listing,
      presignedPsbtBase64,
      sellerTokenPublicKey,
    });
  }

  prepareCancellation(listingId: string, nonceHex: string) {
    const cancelNonce = Buffer.from(nonceHex, "hex");
    if (cancelNonce.length !== 32)
      throw new AppError("TOKEN_AMOUNT_INVALID", "nonce must be 32 bytes");
    const c = {
      version: 1 as const,
      listingId,
      cancelNonce: cancelNonce.toString("hex"),
    };
    return {
      cancelNonce: c.cancelNonce,
      cancelHash: cancellationHashOf(c),
      message: cancellationMessageToSign(c),
    };
  }

  cancelListing(listingId: string, nonceHex: string, signatureB64: string) {
    this.assertMutating();
    return this.market.cancelListing(
      listingId,
      Buffer.from(nonceHex, "hex").toString("hex"),
      signatureB64,
    );
  }

  reserveListing(input: Parameters<MarketService["reserveListing"]>[0]) {
    this.assertMutating();
    return this.market.reserveListing(input);
  }

  preflightReserveListing(
    input: Parameters<MarketService["preflightReserveListing"]>[0],
  ) {
    this.assertMutating();
    return this.market.preflightReserveListing(input);
  }
  buildFillPsbt(
    fillId: string,
    fee: { feeRateSatPerVb?: bigint; minerFeeSats?: bigint },
  ) {
    this.assertMutating();
    return this.market.buildFillPsbt(fillId, fee);
  }

  async submitBuyerSignature(
    fillId: string,
    psbtB64: string,
  ): Promise<{ txid: string }> {
    this.assertMutating();
    await this.market.submitBuyerSignedPsbt(fillId, psbtB64);
    return this.finalizeAndBroadcastFill(fillId);
  }
  finalizeFill(fillId: string) {
    this.assertMutating();
    return this.market.finalizeP2PFill(fillId);
  }
  broadcastFill(validated: Parameters<MarketService["broadcastP2PFill"]>[0]) {
    this.assertMutating();
    return this.market.broadcastP2PFill(validated);
  }
  getFill(fillId: string) {
    return this.db
      .select()
      .from(schema.coveV3MarketFills)
      .where(eq(schema.coveV3MarketFills.id, fillId));
  }
  async publicFillStatus(fillId: string) {
    const rows = await this.db
      .select({
        id: schema.coveV3MarketFills.id,
        tokenId: schema.coveV3MarketFills.tokenId,
        status: schema.coveV3MarketFills.status,
        txid: schema.coveV3MarketFills.txid,
        blockHeight: schema.coveV3MarketFills.blockHeight,
        blockHash: schema.coveV3MarketFills.blockHash,
        canonical: schema.coveV3MarketFills.canonical,
        updatedAt: schema.coveV3MarketFills.updatedAt,
      })
      .from(schema.coveV3MarketFills)
      .where(
        and(
          eq(schema.coveV3MarketFills.network, this.config.network),
          eq(schema.coveV3MarketFills.id, fillId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }
  async finalizeAndBroadcastFill(fillId: string): Promise<{ txid: string }> {
    this.assertMutating();
    const fills = await this.getFill(fillId);
    const fill = fills[0];
    if (!fill) throw new AppError("STATE_CHANGED", "fill not found");
    this.assertCanaryAllowed({
      tokenId: fill.tokenId,
      walletScript: fill.buyerTokenScript,
    });
    if (
      !["BUYER_SIGNED", "SUBMITTING", "BROADCAST", "CONFIRMED"].includes(
        fill.status,
      )
    )
      throw new AppError("STATE_CHANGED", `fill is ${fill.status}`);
    const observation = await this.requireHealthy();
    return this.market.completeFill(fillId, observation);
  }
  getBuyRoutes(tokenId: string, amountAtoms: bigint) {
    return getBuyRoutes(this.db, this.config.network, tokenId, amountAtoms, {
      buyFeeBps: this.config.buyFeeBps,
      p2pFeeBps: this.market.config.p2pFeeBps,
      buyFeeFlatSats: this.config.buyFeeFlatSats,
      p2pFeeMinSats: this.market.config.p2pFeeMinSats,
    });
  }
  getSellOptions(tokenId: string, walletScript: string) {
    return getSellOptions(
      this.db,
      this.config.network,
      tokenId,
      walletScript,
      this.config.redeemFeeBps,
    );
  }

  async listListings(opts: { tokenId?: string; limit?: number } = {}) {
    const limit = Math.min(opts.limit ?? 100, 200);
    const base = [
      eq(schema.coveV3MarketListings.network, this.config.network),
      eq(schema.coveV3MarketListings.status, "ACTIVE"),
    ];
    const cond = opts.tokenId
      ? and(...base, eq(schema.coveV3MarketListings.tokenId, opts.tokenId))
      : and(...base);

    const rows = await this.db
      .select({
        listing: schema.coveV3MarketListings,
        ticker: schema.coveV3Tokens.ticker,
      })
      .from(schema.coveV3MarketListings)
      .leftJoin(
        schema.coveV3Tokens,
        and(
          eq(schema.coveV3Tokens.network, schema.coveV3MarketListings.network),
          eq(schema.coveV3Tokens.tokenId, schema.coveV3MarketListings.tokenId),

          eq(schema.coveV3Tokens.canonical, true),
        ),
      )
      .where(cond)
      .limit(limit);

    return rows.map((r) => ({ ...publicListing(r.listing), ticker: r.ticker }));
  }

  private submissionError(error: unknown): Error {
    if (error instanceof SubmissionError)
      return new AppError(
        error.code === "CONFLICT" ? "PSBT_MUTATED" : "CORE_UNAVAILABLE",
        error.message,
      );
    return error instanceof Error ? error : new Error("submission failed");
  }

  private async beginSessionSubmission(
    session: TxSessionRow,
    signedPsbtBase64: string,
  ): Promise<
    | { job: Submission; psbt: bitcoin.Psbt }
    | { txid: string; submissionState: "saved" | "broadcast" }
  > {
    const incoming = parsePsbt(
      signedPsbtBase64,
      btcNetwork(this.config.network),
    );
    if (unsignedTxDigest(incoming) !== session.unsignedTxDigest)
      throw new AppError("PSBT_MUTATED", "unsigned tx digest changed");
    const first =
      session.operation === "BACKING_BUY" || session.operation === "REDEEM"
        ? 1
        : 0;
    for (let i = first; i < incoming.data.inputs.length; i++)
      validateInputSignature(incoming, i);
    let job: Submission | undefined;
    try {
      const prepared = await prepareSubmission(this.db, {
        network: session.network,
        sourceKind: "APP",
        sourceId: session.id,
        operation: session.operation,
        tokenId: session.tokenId,
        backingTxid: session.backingTxid,
        backingVout: session.backingVout,
        unsignedTxDigest: session.unsignedTxDigest!,
        walletPsbtBase64: signedPsbtBase64,
      });
      if (prepared.phase === "BROADCAST")
        return { txid: prepared.txid!, submissionState: "broadcast" };
      if (prepared.phase === "RECOVERY_REQUIRED")
        await resumeSubmission(this.db, prepared.id);
      job = await claimSubmission(this.db, prepared.id);
      if (job.phase === "READY") {
        try {
          return await this.broadcastSubmission(job);
        } finally {
          await deferSubmission(this.db, job).catch(() => {});
        }
      }
      return {
        job,
        psbt: parsePsbt(job.walletPsbtBase64, btcNetwork(this.config.network)),
      };
    } catch (error) {
      if (job) await deferSubmission(this.db, job).catch(() => {});
      throw this.submissionError(error);
    }
  }

  private async broadcastSubmission(
    job: Submission,
    validated?: ValidatedCoveTransaction,
  ): Promise<{ txid: string; submissionState: "saved" | "broadcast" }> {
    if (job.phase === "SIGNING") {
      if (!validated)
        throw new AppError(
          "STATE_CHANGED",
          "submission has not been validated",
        );
      job = await saveSignedSubmission(this.db, job, {
        rawTxHex: validated.rawTxHex,
        txid: validated.txid,
      });
    }
    if (!job.rawTxHex || !job.txid)
      throw new AppError("STATE_CHANGED", "submission has no signed bytes");
    const conflict = await this.db.execute(sql`update cove_v3_submissions s set
      conflicted = (${indexedBackingConflictQuery(job.network, job.txid)}), conflict_generation = e.chain_generation
      from cove_observation_epochs e where s.id = ${job.id}::uuid and e.network = s.network and s.phase = 'READY' returning s.conflicted`);
    if (conflict.rows[0]?.conflicted === true)
      return { txid: job.txid, submissionState: "saved" };
    const confirmed = await this.db
      .select({ txid: schema.coveV3Events.txid })
      .from(schema.coveV3Events)
      .where(
        and(
          eq(schema.coveV3Events.network, job.network),
          eq(schema.coveV3Events.txid, job.txid),
          eq(schema.coveV3Events.canonical, true),
        ),
      )
      .limit(1);
    try {
      if (!confirmed.length) {
        const health = await this.requireHealthy();
        await broadcastRecordedTransaction(
          this.provider,
          { rawTxHex: job.rawTxHex, txid: job.txid },
          this.config.network,
          healthChainObservation(health, this.provider),
        );
      }
      await publishSubmission(this.db, job);
      return { txid: job.txid, submissionState: "broadcast" };
    } catch {
      return { txid: job.txid, submissionState: "saved" };
    }
  }

  async reconcileSubmissionConflicts(): Promise<number> {
    const result = await this.db
      .execute(sql`update cove_v3_submissions s set conflicted = v.conflict,
      conflict_generation = v.generation, next_attempt_at = case when s.conflicted and not v.conflict then clock_timestamp() else s.next_attempt_at end
      from (select s0.id, e.chain_generation as generation, (${indexedBackingConflictQuery(this.config.network, sql`s0.txid`)}) as conflict
        from cove_v3_submissions s0 join cove_observation_epochs e on e.network = s0.network
        join cove_v3_cursor c on c.network = s0.network and not c.rebuilding
        where s0.network = ${this.config.network} and s0.phase in ('SIGNING','READY') and s0.txid is not null
          and s0.conflict_generation is distinct from e.chain_generation order by s0.id limit 200) v
      where s.id = v.id returning s.id`);
    return result.rows.length;
  }

  async recoverSubmissions(limit = 2): Promise<{ recovered: number }> {
    this.assertMutating();
    let recovered = 0;
    for (const job of await dueSubmissions(
      this.db,
      this.config.network,
      limit,
    )) {
      try {
        if (job.sourceKind === "FILL") {
          const receipt = await this.market.recoverSubmission(job);
          if (receipt.submissionState === "broadcast") recovered++;
          continue;
        } else {
          const owner = await requireTxSession(this.db, job.sourceId);
          this.assertCanaryAllowed({
            tokenId: owner.tokenId ?? undefined,
            walletScript: owner.walletScript,
          });
          if (job.phase === "READY") {
            const claimed = await claimSubmission(this.db, job.id);
            try {
              const receipt = await this.broadcastSubmission(claimed);
              if (receipt.submissionState === "broadcast") recovered++;
            } finally {
              await deferSubmission(this.db, claimed).catch(() => {});
            }
            continue;
          }
          const input = {
            sessionId: job.sourceId,
            signedPsbtBase64: job.walletPsbtBase64,
          };
          if (job.operation === "DEPLOY") await this.submitLaunch(input);
          else if (job.operation === "BACKING_BUY")
            await this.submitBackingBuy(input);
          else if (job.operation === "REDEEM") await this.submitRedeem(input);
          else if (job.operation === "TRANSFER")
            await this.submitTransfer(input);
          else
            throw new AppError(
              "SESSION_STATE_INVALID",
              "unknown saved operation",
            );
        }
        if (
          (
            await getSubmission(
              this.db,
              job.network,
              job.sourceKind,
              job.sourceId,
            )
          )?.phase === "BROADCAST"
        )
          recovered++;
      } catch (error) {
        console.warn(
          "submission recovery deferred:",
          job.id,
          error instanceof AppError ? error.code : "UNAVAILABLE",
        );
      }
    }
    return { recovered };
  }
}
