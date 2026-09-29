import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { eq, and, isNull, inArray, lte, desc, asc, sql } from "drizzle-orm";
import {
  schema,
  observeSubmissionFundingConflict,
  prepareSubmission,
  claimSubmission,
  saveSignedSubmission,
  getSubmission,
  publishSubmission,
  deferSubmission,
  SubmissionError,
  type Submission,
  type Database,
  type DbTransaction,
} from "@crclaunch/db";
import {
  broadcastRecordedTransaction,
  estimateVsize,
  resolveMinerFee,
  FeeError,
  isRpcNotFound,
  type CoreRpcProvider,
} from "@crclaunch/bitcoin";
import {
  TOKEN_CARRIER_SATS,
  type CoveCanonicalView,
} from "@crclaunch/cove-covenant";
import {
  loadCanonicalViewSnapshotFromDb,
  parseCoveTx,
  type HealthReport,
} from "@crclaunch/cove-indexer/v3";
import { deterministicFee, dustThreshold } from "@crclaunch/cove-economics";
import { OP_TRANSFER as OP_TRANSFER_CODE } from "@crclaunch/cove-wire";
import { scriptForKind, spendKindOf } from "@crclaunch/bitcoin";
import { MarketError } from "./errors.js";
import type { MarketConfig } from "./config.js";
import type { ListingV1, CancellationV1 } from "./types.js";
import { listingIdOf, cancellationHashOf } from "./order/hash.js";
import {
  verifyCancellationAuthorization,
  verifyReservationAuthorization,
} from "./order/signature.js";
import { validateListingShape } from "./order/validate.js";
import {
  unsignedTxDigest,
  parsePsbt,
  validateP2wpkhPartialSig,
  partialSigOfInput,
} from "./psbt.js";
import {
  buildListingPsbt,
  verifyListingPsbt,
  presigOf,
  buildPresignedFillPsbt,
  attachSellerPresig,
  FILL_SELLER_INPUT,
} from "./presign.js";
import {
  validateFinalizedP2PFill,
  assertSettlementCap,
  type ValidatedP2PFill,
  type P2PFillTerms,
} from "./finalize.js";
import { assertMarketReady, assertMarketEnabled } from "./health.js";
import { readStoredFeeObservation } from "./fee-observation.js";
bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);
export interface BuyerFundInput {
  txid: string;
  vout: number;
  script: string;
  valueSats: bigint;
}
export interface CreateListingInput extends ListingV1 {
  presignedPsbtBase64: string;
  sellerTokenPublicKey?: string;
}
export const PENDING_LISTING_MAX_BLOCKS = 6n;
export const LISTING_SECRET_COLUMNS = ["sellerPresignedPsbt"] as const;
export function publicListing<
  T extends {
    sellerPresignedPsbt?: string | null;
  },
>(row: T): Omit<T, "sellerPresignedPsbt"> {
  const { sellerPresignedPsbt: _secret, ...rest } = row;
  void _secret;
  return rest;
}
export interface ReserveListingInput {
  listingId: string;
  buyerTokenScript: string;
  buyerChangeScript: string;
  buyerFundInputs: BuyerFundInput[];
  buyerFundPublicKey?: string;
  reserveNonce: string;
  signatureB64: string;
}
type ListingSelect = typeof schema.coveV3MarketListings.$inferSelect;
type FillSelect = typeof schema.coveV3MarketFills.$inferSelect;
interface SourceResolution {
  scriptPubKey: Buffer;
  amountAtoms: bigint;
  valueSats: bigint;
}
function btcNetwork(
  network: MarketConfig["network"],
): bitcoin.networks.Network {
  if (network === "regtest") return bitcoin.networks.regtest;
  if (network === "mainnet") return bitcoin.networks.bitcoin;
  return bitcoin.networks.testnet;
}
function asBuffer(hex: string): Buffer {
  return Buffer.from(hex, "hex");
}
function listingToV1(row: ListingSelect): ListingV1 {
  return {
    orderVersion: row.orderVersion as 1,
    chainIdentity: row.chainIdentity,
    tokenId: row.tokenId,
    sellerTokenScript: row.sellerTokenScript,
    sellerPayoutScript: row.sellerPayoutScript,
    sellerTokenChangeScript: row.sellerTokenChangeScript,
    sourceTxid: row.sourceTxid,
    sourceVout: row.sourceVout,
    sourceAmountAtoms: row.sourceAmountAtoms,
    amountAtoms: row.amountAtoms,
    totalPriceSats: row.totalPriceSats,
    creationHeight: row.creationHeight,
    expiryHeight: row.expiryHeight,
    nonce: row.nonce,
  };
}
const P2P_OP_RETURN_SCRIPT_BYTES = 57;
function assertKeyControls(
  scriptHex: string,
  publicKeyHex: string | undefined,
  network: bitcoin.networks.Network,
  who: string,
): void {
  const script = Buffer.from(scriptHex, "hex");
  const kind = spendKindOf(script);
  if (kind === null)
    throw new MarketError(
      "UNSUPPORTED_ADDRESS",
      `${who} address type is not supported`,
    );
  if (!publicKeyHex) {
    if (kind === "p2wpkh") return;
    throw new MarketError(
      "PUBLIC_KEY_REQUIRED",
      `${who} public key is required for a ${kind} address`,
    );
  }
  let derived: Buffer;
  try {
    derived = scriptForKind(kind, Buffer.from(publicKeyHex, "hex"), network);
  } catch {
    throw new MarketError(
      "PUBLIC_KEY_REQUIRED",
      `${who} public key is invalid`,
    );
  }
  if (!derived.equals(script))
    throw new MarketError(
      "PUBLIC_KEY_REQUIRED",
      `${who} public key does not control that address`,
    );
}
function fillFundInputs(fill: FillSelect): BuyerFundInput[] {
  const raw = fill.buyerFundInputs as unknown as {
    txid: string;
    vout: number;
    script: string;
    valueSats: string;
  }[];
  return raw.map((f) => ({
    txid: f.txid,
    vout: f.vout,
    script: f.script,
    valueSats: BigInt(f.valueSats),
  }));
}
export class MarketService {
  constructor(
    readonly db: Database,
    readonly provider: CoreRpcProvider,
    readonly config: MarketConfig,
  ) {}
  marketFeeFor(totalPriceSats: bigint): bigint {
    return deterministicFee(
      totalPriceSats,
      this.config.p2pFeeBps,
      0n,
      this.config.p2pFeeMinSats,
    );
  }
  private async resolveSource(listing: ListingV1): Promise<SourceResolution> {
    const rows = await this.db
      .select()
      .from(schema.coveV3TokenUtxos)
      .where(
        and(
          eq(schema.coveV3TokenUtxos.network, this.config.network),
          eq(schema.coveV3TokenUtxos.txid, listing.sourceTxid),
          eq(schema.coveV3TokenUtxos.vout, listing.sourceVout),
          eq(schema.coveV3TokenUtxos.tokenId, listing.tokenId),
          eq(schema.coveV3TokenUtxos.scriptPubKey, listing.sellerTokenScript),
          eq(schema.coveV3TokenUtxos.canonical, true),
          isNull(schema.coveV3TokenUtxos.spentByTxid),
        ),
      );
    if (rows.length !== 1)
      throw new MarketError(
        "LISTING_BAD_SOURCE",
        "source token UTXO not canonical/unspent",
      );
    const row = rows[0]!;
    if (row.amountAtoms !== listing.sourceAmountAtoms) {
      throw new MarketError(
        "LISTING_SOURCE_MISMATCH",
        "source amount mismatch vs indexer",
      );
    }
    const txout = await this.provider.getTxout(
      listing.sourceTxid,
      listing.sourceVout,
    );
    if (!txout)
      throw new MarketError(
        "LISTING_SOURCE_SPENT",
        "source outpoint already spent",
      );
    if (txout.scriptPubKeyHex !== listing.sellerTokenScript) {
      throw new MarketError(
        "LISTING_SOURCE_MISMATCH",
        "source script mismatch vs Core",
      );
    }
    return {
      scriptPubKey: asBuffer(listing.sellerTokenScript),
      amountAtoms: row.amountAtoms,
      valueSats: txout.valueSats,
    };
  }
  private async resolvePendingSource(
    listing: ListingV1,
  ): Promise<SourceResolution> {
    const txout = await this.provider.getTxout(
      listing.sourceTxid,
      listing.sourceVout,
    );
    if (!txout)
      throw new MarketError(
        "LISTING_BAD_SOURCE",
        "source outpoint is not an unspent output",
      );
    if (
      txout.scriptPubKeyHex !== listing.sellerTokenScript ||
      txout.valueSats !== TOKEN_CARRIER_SATS
    ) {
      throw new MarketError(
        "LISTING_SOURCE_MISMATCH",
        "source output is not a token carrier at the seller's address",
      );
    }
    let raw: string;
    try {
      raw = await this.provider.getRawTransaction(listing.sourceTxid);
    } catch (error) {
      throw new MarketError(
        isRpcNotFound(error, "getrawtransaction")
          ? "LISTING_BAD_SOURCE"
          : "CORE_UNAVAILABLE",
        "source transaction cannot currently be verified",
      );
    }
    const parsed = parseCoveTx(raw);
    if (parsed.kind !== "TRANSFER" || parsed.envelope.op !== OP_TRANSFER_CODE) {
      throw new MarketError(
        "LISTING_BAD_SOURCE",
        "source is not the output of a covs transfer",
      );
    }
    if (parsed.envelope.tokenId.toString("hex") !== listing.tokenId) {
      throw new MarketError(
        "LISTING_SOURCE_MISMATCH",
        "source transfer moves another token",
      );
    }
    const alloc = parsed.envelope.allocations.find(
      (a) => a.vout === listing.sourceVout,
    );
    if (!alloc || alloc.amount !== listing.sourceAmountAtoms) {
      throw new MarketError(
        "LISTING_SOURCE_MISMATCH",
        "source transfer does not put the listed amount on that output",
      );
    }
    return {
      scriptPubKey: asBuffer(listing.sellerTokenScript),
      amountAtoms: alloc.amount,
      valueSats: txout.valueSats,
    };
  }
  private async loadListing(listingId: string): Promise<ListingSelect | null> {
    const rows = await this.db
      .select()
      .from(schema.coveV3MarketListings)
      .where(eq(schema.coveV3MarketListings.listingId, listingId));
    return rows[0] ?? null;
  }
  private async loadFill(fillId: string): Promise<FillSelect | null> {
    const rows = await this.db
      .select()
      .from(schema.coveV3MarketFills)
      .where(eq(schema.coveV3MarketFills.id, fillId));
    return rows[0] ?? null;
  }
  async preflightReserveListing(
    input: Pick<
      ReserveListingInput,
      "listingId" | "reserveNonce" | "buyerTokenScript" | "signatureB64"
    >,
  ): Promise<void> {
    if (
      !verifyReservationAuthorization(
        {
          version: 1,
          listingId: input.listingId,
          reserveNonce: input.reserveNonce,
          buyerTokenScript: input.buyerTokenScript,
        },
        input.signatureB64,
      )
    ) {
      throw new MarketError(
        "LISTING_BAD_SIGNATURE",
        "reservation BIP-322 signature invalid",
      );
    }
    const listing = await this.loadListing(input.listingId);
    if (!listing || listing.network !== this.config.network)
      throw new MarketError("STATE_CHANGED", "listing not found");
    if (listing.status !== "ACTIVE")
      throw new MarketError("LISTING_RESERVED", `listing is ${listing.status}`);
  }
  async createListing(input: CreateListingInput): Promise<string> {
    if (input.chainIdentity !== this.config.chainIdentity) {
      throw new MarketError(
        "CHAIN_IDENTITY_MISMATCH",
        `listing chainIdentity ${input.chainIdentity} != server ${this.config.chainIdentity}`,
      );
    }
    validateListingShape(input);
    const listingWindow = input.expiryHeight - input.creationHeight;
    if (listingWindow > this.config.maxListingBlocks) {
      throw new MarketError(
        "LISTING_EXPIRY_TOO_FAR",
        `listing would stay open for ${listingWindow} blocks; the limit is ` +
          `${this.config.maxListingBlocks} (about ${this.config.maxListingBlocks / 144n} days)`,
      );
    }
    assertKeyControls(
      input.sellerTokenScript,
      input.sellerTokenPublicKey,
      btcNetwork(this.config.network),
      "seller token",
    );
    if (input.amountAtoms !== input.sourceAmountAtoms) {
      throw new MarketError(
        "LISTING_AMOUNT_INVALID",
        "a listing sells a whole token carrier; split off the amount first",
      );
    }
    await assertMarketReady({
      db: this.db,
      config: this.config,
      provider: this.provider,
    });
    let pending = false;
    let source: SourceResolution;
    try {
      source = await this.resolveSource(input);
    } catch (e) {
      if (!(e instanceof MarketError) || e.code !== "LISTING_BAD_SOURCE")
        throw e;
      source = await this.resolvePendingSource(input);
      pending = true;
    }
    verifyListingPsbt(input.presignedPsbtBase64, {
      network: btcNetwork(this.config.network),
      source: {
        txid: input.sourceTxid,
        vout: input.sourceVout,
        script: source.scriptPubKey,
        valueSats: source.valueSats,
        publicKey: input.sellerTokenPublicKey
          ? asBuffer(input.sellerTokenPublicKey)
          : undefined,
      },
      payoutScript: asBuffer(input.sellerPayoutScript),
      priceSats: input.totalPriceSats,
    });
    if (
      input.totalPriceSats < dustThreshold(asBuffer(input.sellerPayoutScript))
    ) {
      throw new MarketError(
        "SELLER_PAYOUT_DUST",
        "seller payout below relay dust",
      );
    }
    assertSettlementCap(input.totalPriceSats, this.config.maxP2pSettlementSats);
    const marketFee = this.marketFeeFor(input.totalPriceSats);
    if (marketFee < dustThreshold(this.config.feeScript)) {
      throw new MarketError("MARKET_FEE_DUST", "p2p fee below relay dust");
    }
    const listingId = listingIdOf(input);
    await this.db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(schema.coveV3MarketListings)
        .where(eq(schema.coveV3MarketListings.listingId, listingId));
      if (existing.length > 0)
        throw new MarketError("STATE_CHANGED", "listingId already exists");
      await tx.insert(schema.coveV3MarketListings).values({
        listingId,
        network: this.config.network,
        chainIdentity: input.chainIdentity,
        tokenId: input.tokenId,
        orderVersion: input.orderVersion,
        sellerTokenScript: input.sellerTokenScript,
        sellerPayoutScript: input.sellerPayoutScript,
        sellerTokenChangeScript: input.sellerTokenChangeScript,
        sourceTxid: input.sourceTxid,
        sourceVout: input.sourceVout,
        sourceAmountAtoms: input.sourceAmountAtoms,
        amountAtoms: input.amountAtoms,
        totalPriceSats: input.totalPriceSats,
        creationHeight: input.creationHeight,
        expiryHeight: input.expiryHeight,
        nonce: input.nonce,
        signatureB64: "",
        sellerTokenPublicKey: input.sellerTokenPublicKey ?? null,
        sellerPresignedPsbt: input.presignedPsbtBase64,
        status: pending ? "PENDING" : "ACTIVE",
      });
      await tx.insert(schema.coveV3MarketListingInputs).values({
        listingId,
        sourceTxid: input.sourceTxid,
        sourceVout: input.sourceVout,
        amountAtoms: input.sourceAmountAtoms,
        scriptPubKey: input.sellerTokenScript,
      });
      await tx.insert(schema.coveV3MarketEvents).values({
        network: this.config.network,
        listingId,
        eventType: "LISTING_CREATED",
        payloadJson: {
          amountAtoms: input.amountAtoms.toString(),
          totalPriceSats: input.totalPriceSats.toString(),
          pending,
        },
      });
    });
    return listingId;
  }
  async buildListingPsbtFor(
    listing: ListingV1,
    sellerTokenPublicKey?: string,
  ): Promise<string> {
    validateListingShape(listing);
    if (listing.amountAtoms !== listing.sourceAmountAtoms) {
      throw new MarketError(
        "LISTING_AMOUNT_INVALID",
        "a listing sells a whole token carrier; split off the amount first",
      );
    }
    assertKeyControls(
      listing.sellerTokenScript,
      sellerTokenPublicKey,
      btcNetwork(this.config.network),
      "seller token",
    );
    let source: SourceResolution;
    try {
      source = await this.resolveSource(listing);
    } catch (e) {
      if (!(e instanceof MarketError) || e.code !== "LISTING_BAD_SOURCE")
        throw e;
      source = await this.resolvePendingSource(listing);
    }
    return buildListingPsbt({
      network: btcNetwork(this.config.network),
      source: {
        txid: listing.sourceTxid,
        vout: listing.sourceVout,
        script: source.scriptPubKey,
        valueSats: source.valueSats,
        publicKey: sellerTokenPublicKey
          ? asBuffer(sellerTokenPublicKey)
          : undefined,
      },
      payoutScript: asBuffer(listing.sellerPayoutScript),
      priceSats: listing.totalPriceSats,
    }).toBase64();
  }
  async cancelListing(
    listingId: string,
    cancelNonce: string,
    signatureB64: string,
  ): Promise<void> {
    const listing = await this.loadListing(listingId);
    if (!listing) throw new MarketError("STATE_CHANGED", "listing not found");
    const cancellation: CancellationV1 = { version: 1, listingId, cancelNonce };
    if (
      !verifyCancellationAuthorization(
        listingToV1(listing),
        cancellation,
        signatureB64,
      )
    ) {
      throw new MarketError(
        "LISTING_BAD_SIGNATURE",
        "cancellation BIP-322 signature invalid",
      );
    }
    const cancelHash = cancellationHashOf(cancellation);
    await this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(schema.coveV3MarketListings)
        .where(eq(schema.coveV3MarketListings.listingId, listingId))
        .for("update");
      const row = rows[0];
      if (!row) throw new MarketError("STATE_CHANGED", "listing not found");
      if (
        row.status === "FILLED" ||
        row.status === "CANCELLED" ||
        row.status === "BROADCAST"
      ) {
        throw new MarketError(
          "LISTING_CANCELLED",
          `cannot cancel ${row.status} listing`,
        );
      }
      const submitting = await tx
        .select({ id: schema.coveV3MarketFills.id })
        .from(schema.coveV3MarketFills)
        .where(
          and(
            eq(schema.coveV3MarketFills.listingId, listingId),
            eq(schema.coveV3MarketFills.status, "SUBMITTING"),
          ),
        )
        .limit(1);
      if (submitting.length)
        throw new MarketError(
          "STATE_CHANGED",
          "a signed fill is being submitted",
        );
      await tx
        .insert(schema.coveV3MarketCancellations)
        .values({ listingId, cancelHash, cancelNonce, signatureB64 });
      await tx
        .update(schema.coveV3MarketListings)
        .set({ status: "CANCELLED", updatedAt: new Date() })
        .where(eq(schema.coveV3MarketListings.listingId, listingId));
      await tx
        .update(schema.coveV3MarketFills)
        .set({ status: "CANCELLED", updatedAt: new Date() })
        .where(
          and(
            eq(schema.coveV3MarketFills.listingId, listingId),
            inArray(schema.coveV3MarketFills.status, [
              "RESERVED",
              "PSBT_BUILT",
              "BUYER_SIGNED",
            ]),
          ),
        );
      await tx
        .update(schema.coveV3MarketListings)
        .set({ sellerPresignedPsbt: null })
        .where(eq(schema.coveV3MarketListings.listingId, listingId));
      await tx.insert(schema.coveV3MarketEvents).values({
        network: this.config.network,
        listingId,
        eventType: "LISTING_CANCELLED",
        payloadJson: { cancelHash },
      });
    });
  }
  async reserveListing(input: ReserveListingInput): Promise<string> {
    if (
      !verifyReservationAuthorization(
        {
          version: 1,
          listingId: input.listingId,
          reserveNonce: input.reserveNonce,
          buyerTokenScript: input.buyerTokenScript,
        },
        input.signatureB64,
      )
    ) {
      throw new MarketError(
        "LISTING_BAD_SIGNATURE",
        "reservation BIP-322 signature invalid",
      );
    }
    for (const f of input.buyerFundInputs) {
      if (f.script !== input.buyerChangeScript) {
        throw new MarketError(
          "BUYER_FUNDS_INSUFFICIENT",
          "every funding coin must belong to the buyer's payment address",
        );
      }
    }
    assertKeyControls(
      input.buyerChangeScript,
      input.buyerFundPublicKey,
      btcNetwork(this.config.network),
      "buyer payment",
    );
    const carriers = await this.db
      .select({
        txid: schema.coveV3TokenUtxos.txid,
        vout: schema.coveV3TokenUtxos.vout,
      })
      .from(schema.coveV3TokenUtxos)
      .where(
        and(
          eq(schema.coveV3TokenUtxos.network, this.config.network),
          isNull(schema.coveV3TokenUtxos.spentByTxid),
          eq(schema.coveV3TokenUtxos.scriptPubKey, input.buyerChangeScript),
        ),
      );
    const carrierKeys = new Set(carriers.map((c) => `${c.txid}:${c.vout}`));
    if (
      input.buyerFundInputs.some((f) => carrierKeys.has(`${f.txid}:${f.vout}`))
    ) {
      throw new MarketError(
        "BUYER_FUNDS_INSUFFICIENT",
        "a funding coin holds tokens and cannot pay for a purchase",
      );
    }
    const listing = await this.loadListing(input.listingId);
    if (!listing) throw new MarketError("STATE_CHANGED", "listing not found");
    await assertMarketReady({
      db: this.db,
      config: this.config,
      provider: this.provider,
    });
    await this.resolveSource(listingToV1(listing));
    const tip = BigInt(await this.provider.getBestHeight());
    const fillId = await this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(schema.coveV3MarketListings)
        .where(eq(schema.coveV3MarketListings.listingId, input.listingId))
        .for("update");
      const row = rows[0];
      if (!row) throw new MarketError("STATE_CHANGED", "listing not found");
      if (row.status !== "ACTIVE")
        throw new MarketError("LISTING_RESERVED", `listing is ${row.status}`);
      if (row.expiryHeight <= tip) {
        await tx
          .update(schema.coveV3MarketListings)
          .set({ status: "EXPIRED", updatedAt: new Date() })
          .where(eq(schema.coveV3MarketListings.listingId, input.listingId));
        throw new MarketError("LISTING_EXPIRED", "listing expired");
      }
      const marketFee = this.marketFeeFor(row.totalPriceSats);
      const [inserted] = await tx
        .insert(schema.coveV3MarketFills)
        .values({
          listingId: input.listingId,
          network: this.config.network,
          tokenId: row.tokenId,
          buyerTokenScript: input.buyerTokenScript,
          buyerChangeScript: input.buyerChangeScript,
          buyerFundInputs: input.buyerFundInputs.map((f) => ({
            txid: f.txid,
            vout: f.vout,
            script: f.script,
            valueSats: f.valueSats.toString(),
          })),
          buyerFundPublicKey: input.buyerFundPublicKey ?? null,
          amountAtoms: row.amountAtoms,
          totalPriceSats: row.totalPriceSats,
          marketFeeSats: marketFee,
          extraCarrierSats: 0n,
          minerFeeSats: 0n,
          status: "RESERVED",
          reservationExpiresAt: new Date(
            Date.now() + this.config.reservationTtlSeconds * 1000,
          ),
        })
        .returning({ id: schema.coveV3MarketFills.id });
      await tx
        .update(schema.coveV3MarketListings)
        .set({ status: "RESERVED", updatedAt: new Date() })
        .where(eq(schema.coveV3MarketListings.listingId, input.listingId));
      return inserted!.id;
    });
    return fillId;
  }
  async buildFillPsbt(
    fillId: string,
    fee:
      | bigint
      | {
          feeRateSatPerVb?: bigint;
          minerFeeSats?: bigint;
        },
  ): Promise<string> {
    const feeInput = typeof fee === "bigint" ? { minerFeeSats: fee } : fee;
    assertMarketEnabled(this.config);
    const fill = await this.loadFill(fillId);
    if (!fill) throw new MarketError("STATE_CHANGED", "fill not found");
    if (fill.status !== "RESERVED" && fill.status !== "PSBT_BUILT")
      throw new MarketError("STATE_CHANGED", `fill is ${fill.status}`);
    const listing = await this.loadListing(fill.listingId);
    if (!listing) throw new MarketError("STATE_CHANGED", "listing not found");
    await assertMarketReady({
      db: this.db,
      config: this.config,
      provider: this.provider,
    });
    const source = await this.resolveSource(listingToV1(listing));
    const marketFee = this.marketFeeFor(listing.totalPriceSats);
    const funderInputs = fillFundInputs(fill).map((f) => ({
      txid: f.txid,
      vout: f.vout,
      script: asBuffer(f.script),
      valueSats: f.valueSats,
      publicKey: fill.buyerFundPublicKey
        ? asBuffer(fill.buyerFundPublicKey)
        : undefined,
    }));
    const rates = await readStoredFeeObservation(this.db, this.config.network);
    const standard =
      rates.tiers.find((t) => t.key === "standard") ?? rates.tiers[0]!;
    const vsize = estimateVsize({
      vaultInputs: 0,
      p2wpkhInputs: 1 + funderInputs.length,
      outputScriptBytes: [
        P2P_OP_RETURN_SCRIPT_BYTES,
        listing.sellerPayoutScript.length / 2,
        fill.buyerTokenScript.length / 2,
        this.config.feeScript.length,
        fill.buyerChangeScript.length / 2,
      ],
    });
    let minerFeeSats: bigint;
    try {
      minerFeeSats = resolveMinerFee({
        rateSatPerVb:
          feeInput.feeRateSatPerVb ??
          (feeInput.minerFeeSats === undefined ? standard.satPerVb : undefined),
        explicitSats: feeInput.minerFeeSats,
        vsize,
        floorSatPerVb: rates.floorSatPerVb,
        ceilingSatPerVb: rates.ceilingSatPerVb,
        maxMinerFeeSats: this.config.maxMinerFeeSats,
      }).minerFeeSats;
    } catch (e) {
      if (e instanceof FeeError)
        throw new MarketError("BUYER_FUNDS_INSUFFICIENT", e.message);
      throw e;
    }
    const result = buildPresignedFillPsbt({
      network: btcNetwork(this.config.network),
      tokenId: Buffer.from(listing.tokenId, "hex"),
      seller: {
        txid: listing.sourceTxid,
        vout: listing.sourceVout,
        script: source.scriptPubKey,
        valueSats: source.valueSats,
        publicKey: listing.sellerTokenPublicKey
          ? asBuffer(listing.sellerTokenPublicKey)
          : undefined,
        amountAtoms: listing.sourceAmountAtoms,
      },
      payoutScript: asBuffer(listing.sellerPayoutScript),
      priceSats: listing.totalPriceSats,
      buyerTokenScript: asBuffer(fill.buyerTokenScript),
      fundInputs: funderInputs,
      buyerChangeScript: asBuffer(fill.buyerChangeScript),
      feeScript: this.config.feeScript,
      marketFeeSats: marketFee,
      minerFeeSats,
    });
    const extraCarrierSats = 0n;
    const settledMinerFeeSats = result.minerFeeSats;
    const psbtB64 = result.psbt.toBase64();
    const digest = unsignedTxDigest(result.psbt);
    const changed = await this.db
      .update(schema.coveV3MarketFills)
      .set({
        psbtBase64: psbtB64,
        unsignedTxDigest: digest,
        minerFeeSats: settledMinerFeeSats,
        extraCarrierSats,
        marketFeeSats: marketFee,
        status: "PSBT_BUILT",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.coveV3MarketFills.id, fillId),
          inArray(schema.coveV3MarketFills.status, ["RESERVED", "PSBT_BUILT"]),
        ),
      )
      .returning({ id: schema.coveV3MarketFills.id });
    if (!changed.length)
      throw new MarketError(
        "STATE_CHANGED",
        "fill advanced while its PSBT was being built",
      );
    return psbtB64;
  }
  async submitBuyerSignedPsbt(fillId: string, psbtB64: string): Promise<void> {
    const fill = await this.loadFill(fillId);
    if (!fill) throw new MarketError("STATE_CHANGED", "fill not found");
    if (
      ![
        "PSBT_BUILT",
        "BUYER_SIGNED",
        "SUBMITTING",
        "BROADCAST",
        "CONFIRMED",
      ].includes(fill.status)
    )
      throw new MarketError("STATE_CHANGED", `fill is ${fill.status}`);
    const psbt = parsePsbt(psbtB64, btcNetwork(this.config.network));
    if (
      fill.unsignedTxDigest &&
      unsignedTxDigest(psbt) !== fill.unsignedTxDigest
    ) {
      throw new MarketError("PSBT_MUTATED", "unsigned tx digest mismatch");
    }
    if (partialSigOfInput(psbt, FILL_SELLER_INPUT) !== null) {
      throw new MarketError(
        "PSBT_MUTATED",
        "the seller's carrier must not be signed by the buyer",
      );
    }
    const expectedFunding = new Map(
      fillFundInputs(fill).map((input) => [
        `${input.txid.toLowerCase()}:${input.vout}`,
        input,
      ]),
    );
    psbt.data.inputs.forEach((input, i) => {
      if (i === FILL_SELLER_INPUT) return;
      const point = psbt.txInputs[i]!;
      const expected = expectedFunding.get(
        `${Buffer.from(point.hash).reverse().toString("hex")}:${point.index}`,
      );
      if (
        !expected ||
        !input.witnessUtxo ||
        BigInt(input.witnessUtxo.value) !== expected.valueSats ||
        input.witnessUtxo.script.toString("hex") !==
          expected.script.toLowerCase()
      ) {
        throw new MarketError("PSBT_MUTATED", "buyer funding prevout changed");
      }
      validateP2wpkhPartialSig(psbt, i);
    });
    if (fill.status !== "PSBT_BUILT") return;
    const changed = await this.db
      .update(schema.coveV3MarketFills)
      .set({
        psbtBase64: psbtB64,
        status: "BUYER_SIGNED",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.coveV3MarketFills.id, fillId),
          eq(schema.coveV3MarketFills.status, "PSBT_BUILT"),
          eq(schema.coveV3MarketFills.unsignedTxDigest, fill.unsignedTxDigest!),
        ),
      )
      .returning({ id: schema.coveV3MarketFills.id });
    if (!changed.length) {
      const current = await this.loadFill(fillId);
      if (
        !current ||
        current.unsignedTxDigest !== fill.unsignedTxDigest ||
        !["BUYER_SIGNED", "SUBMITTING", "BROADCAST", "CONFIRMED"].includes(
          current.status,
        )
      ) {
        throw new MarketError(
          "STATE_CHANGED",
          "fill changed while the buyer was signing",
        );
      }
    }
  }
  async completeFill(
    fillId: string,
    observation?: HealthReport,
  ): Promise<{
    txid: string;
    submissionState: "saved" | "broadcast";
  }> {
    const existing = await getSubmission(
      this.db,
      this.config.network,
      "FILL",
      fillId,
    );
    if (existing) return this.recoverSubmission(existing);
    const validated = await this.finalizeP2PFill(fillId, observation);
    return this.broadcastP2PFill(validated);
  }
  async finalizeP2PFill(
    fillId: string,
    observation?: HealthReport,
  ): Promise<ValidatedP2PFill> {
    assertMarketEnabled(this.config);
    const fill = await this.loadFill(fillId);
    if (!fill) throw new MarketError("STATE_CHANGED", "fill not found");
    if (
      fill.status !== "BUYER_SIGNED" &&
      fill.status !== "SUBMITTING" &&
      fill.status !== "BROADCAST"
    )
      throw new MarketError("STATE_CHANGED", `fill is ${fill.status}`);
    if (!fill.psbtBase64)
      throw new MarketError("STATE_CHANGED", "fill has no PSBT");
    const listing = await this.loadListing(fill.listingId);
    if (!listing) throw new MarketError("STATE_CHANGED", "listing not found");
    if (!listing.sellerPresignedPsbt)
      throw new MarketError(
        "LISTING_CANCELLED",
        "the listing's signature is gone (cancelled)",
      );
    assertSettlementCap(
      listing.totalPriceSats,
      this.config.maxP2pSettlementSats,
    );
    await assertMarketReady({
      db: this.db,
      config: this.config,
      provider: this.provider,
      observation,
    });
    const network = btcNetwork(this.config.network);
    const psbt = parsePsbt(fill.psbtBase64, network);
    attachSellerPresig(psbt, presigOf(listing.sellerPresignedPsbt, network));
    psbt.finalizeAllInputs();
    const rawTxHex = psbt.extractTransaction().toHex();
    const terms = this.buildTerms(listing, fill);
    const view = await this.loadView(
      listing.tokenId,
      listing.sourceTxid,
      listing.sourceVout,
    );
    const validated = validateFinalizedP2PFill({
      rawTxHex,
      terms,
      view,
      network: this.config.network,
    });
    return validated;
  }
  async broadcastP2PFill(validated: ValidatedP2PFill): Promise<{
    txid: string;
    submissionState: "saved" | "broadcast";
  }> {
    const fill = await this.loadFill(validated.fillId);
    if (
      !fill?.psbtBase64 ||
      !fill.unsignedTxDigest ||
      fill.tokenId !== validated.tokenId ||
      fill.listingId !== validated.listingId
    ) {
      throw new MarketError("STATE_CHANGED", "fill commitment is unavailable");
    }
    try {
      const prepared = await prepareSubmission(this.db, {
        network: this.config.network,
        sourceKind: "FILL",
        sourceId: fill.id,
        operation: "P2P",
        tokenId: fill.tokenId,
        backingTxid: null,
        backingVout: null,
        unsignedTxDigest: fill.unsignedTxDigest,
        walletPsbtBase64: fill.psbtBase64,
      });
      return await this.runSubmission(prepared, validated);
    } catch (error) {
      if (error instanceof SubmissionError)
        throw new MarketError("CORE_UNAVAILABLE", error.message);
      throw error;
    }
  }
  async recoverSubmission(saved: Submission): Promise<{
    txid: string;
    submissionState: "saved" | "broadcast";
  }> {
    if (saved.network !== this.config.network || saved.sourceKind !== "FILL")
      throw new MarketError("STATE_CHANGED", "wrong saved fill");
    if (
      saved.phase === "READY" &&
      saved.txid &&
      (await observeSubmissionFundingConflict(this.db, saved))
    ) {
      return { txid: saved.txid, submissionState: "saved" };
    }
    if (saved.phase !== "BROADCAST") {
      await assertMarketReady({
        db: this.db,
        config: this.config,
        provider: this.provider,
      });
      const fill = await this.loadFill(saved.sourceId);
      const listing = fill ? await this.loadListing(fill.listingId) : null;
      if (!listing)
        throw new MarketError(
          "STATE_CHANGED",
          "saved fill listing is unavailable",
        );
      assertSettlementCap(
        listing.totalPriceSats,
        this.config.maxP2pSettlementSats,
      );
    }
    return this.runSubmission(saved);
  }
  private async runSubmission(
    saved: Submission,
    validated?: ValidatedP2PFill,
  ): Promise<{
    txid: string;
    submissionState: "saved" | "broadcast";
  }> {
    if (saved.phase === "BROADCAST")
      return { txid: saved.txid!, submissionState: "broadcast" };
    let job: Submission | undefined;
    try {
      job = await claimSubmission(this.db, saved.id);
      if (job.phase === "SIGNING") {
        validated ??= await this.finalizeP2PFill(saved.sourceId);
        job = await saveSignedSubmission(this.db, job, {
          rawTxHex: validated.validatedTransfer.rawTxHex,
          txid: validated.txid,
        });
      }
      if (!job.rawTxHex || !job.txid)
        throw new MarketError("STATE_CHANGED", "fill has no saved transaction");
      if (await observeSubmissionFundingConflict(this.db, job))
        return { txid: job.txid, submissionState: "saved" };
      try {
        const fill = await this.loadFill(job.sourceId);
        const listing = fill ? await this.loadListing(fill.listingId) : null;
        const source = listing
          ? await this.sourceUtxoRow(listing.sourceTxid, listing.sourceVout)
          : null;
        if (!source?.canonical || source.spentByTxid !== job.txid) {
          await broadcastRecordedTransaction(
            this.provider,
            { rawTxHex: job.rawTxHex, txid: job.txid },
            this.config.network,
          );
        }
        await publishSubmission(this.db, job);
        return { txid: job.txid, submissionState: "broadcast" };
      } catch {
        return { txid: job.txid, submissionState: "saved" };
      }
    } catch (error) {
      if (error instanceof SubmissionError)
        throw new MarketError("CORE_UNAVAILABLE", error.message);
      throw error;
    } finally {
      if (job) await deferSubmission(this.db, job).catch(() => {});
    }
  }
  private reconciledGeneration = "";
  async reconcileMarket(
    observedTip?: bigint,
    indexedGeneration?: string,
  ): Promise<{
    expired: number;
    invalidated: number;
    confirmed: number;
    reorged: number;
  }> {
    const tip = observedTip ?? BigInt(await this.provider.getBestHeight());
    let expired = 0;
    let invalidated = 0;
    let confirmed = 0;
    let reorged = 0;
    const pendingListings = await this.db
      .select()
      .from(schema.coveV3MarketListings)
      .where(
        and(
          eq(schema.coveV3MarketListings.network, this.config.network),
          eq(schema.coveV3MarketListings.status, "PENDING"),
        ),
      )
      .orderBy(asc(schema.coveV3MarketListings.lastObservedAt))
      .limit(2);
    for (const listing of pendingListings) {
      await this.db
        .update(schema.coveV3MarketListings)
        .set({ lastObservedAt: new Date() })
        .where(eq(schema.coveV3MarketListings.listingId, listing.listingId));
      const utxo = await this.sourceUtxoRow(
        listing.sourceTxid,
        listing.sourceVout,
      );
      if (utxo && utxo.canonical && !utxo.spentByTxid) {
        const matches =
          utxo.tokenId === listing.tokenId &&
          utxo.amountAtoms === listing.sourceAmountAtoms &&
          utxo.scriptPubKey === listing.sellerTokenScript;
        if (matches) {
          await this.db
            .update(schema.coveV3MarketListings)
            .set({ status: "ACTIVE", updatedAt: new Date() })
            .where(
              eq(schema.coveV3MarketListings.listingId, listing.listingId),
            );
          await this.db.insert(schema.coveV3MarketEvents).values({
            network: this.config.network,
            listingId: listing.listingId,
            eventType: "LISTING_ACTIVE",
            payloadJson: {},
          });
        } else {
          await this.invalidateListing(
            listing.listingId,
            "indexed carrier differs from the listing",
          );
          invalidated++;
        }
        continue;
      }
      const gone = utxo?.spentByTxid
        ? true
        : !(await this.provider.getTxout(
            listing.sourceTxid,
            listing.sourceVout,
          ));
      if (gone || tip > listing.creationHeight + PENDING_LISTING_MAX_BLOCKS) {
        await this.invalidateListing(
          listing.listingId,
          gone
            ? "carrier spent before it confirmed"
            : "carrier never confirmed",
        );
        invalidated++;
      }
    }
    const broadcastFills = await this.db
      .select()
      .from(schema.coveV3MarketFills)
      .where(
        and(
          eq(schema.coveV3MarketFills.network, this.config.network),
          eq(schema.coveV3MarketFills.status, "BROADCAST"),
          sql`exists (
        select 1 from cove_v3_market_listings l join cove_v3_token_utxos u on u.network = l.network and u.txid = l.source_txid and u.vout = l.source_vout
        where l.network = ${this.config.network} and l.listing_id = ${schema.coveV3MarketFills.listingId} and u.canonical and u.spent_by_txid = ${schema.coveV3MarketFills.txid})`,
        ),
      )
      .limit(200);
    for (const fill of broadcastFills) {
      const listing = await this.loadListing(fill.listingId);
      if (!listing) continue;
      const utxo = await this.sourceUtxoRow(
        listing.sourceTxid,
        listing.sourceVout,
      );
      if (utxo && utxo.spentByTxid === fill.txid && utxo.canonical) {
        await this.db.transaction(async (tx) => {
          await tx
            .update(schema.coveV3MarketFills)
            .set({
              status: "CONFIRMED",
              blockHeight: utxo.spentHeight ?? tip,
              blockHash: utxo.spentBlockHash,
              updatedAt: new Date(),
            })
            .where(eq(schema.coveV3MarketFills.id, fill.id));
          await tx
            .update(schema.coveV3MarketListings)
            .set({ status: "FILLED", updatedAt: new Date() })
            .where(
              eq(schema.coveV3MarketListings.listingId, listing.listingId),
            );
          await this.ensureTrade(
            tx,
            fill,
            listing,
            utxo.spentHeight ?? tip,
            utxo.spentBlockHash,
          );
          await tx.insert(schema.coveV3MarketEvents).values({
            network: this.config.network,
            listingId: listing.listingId,
            fillId: fill.id,
            eventType: "FILL_CONFIRMED",
            payloadJson: { txid: fill.txid },
          });
        });
        confirmed++;
      }
    }
    const confirmedFills =
      indexedGeneration !== undefined &&
      indexedGeneration === this.reconciledGeneration
        ? []
        : await this.db
            .select()
            .from(schema.coveV3MarketFills)
            .where(
              and(
                eq(schema.coveV3MarketFills.network, this.config.network),
                eq(schema.coveV3MarketFills.status, "CONFIRMED"),
                sql`not exists (
        select 1 from cove_v3_market_listings l join cove_v3_token_utxos u on u.network = l.network and u.txid = l.source_txid and u.vout = l.source_vout
        where l.network = ${this.config.network} and l.listing_id = ${schema.coveV3MarketFills.listingId} and u.canonical and u.spent_by_txid = ${schema.coveV3MarketFills.txid})`,
              ),
            )
            .limit(200);
    for (const fill of confirmedFills) {
      const listing = await this.loadListing(fill.listingId);
      if (!listing) continue;
      const utxo = await this.sourceUtxoRow(
        listing.sourceTxid,
        listing.sourceVout,
      );
      if (utxo && utxo.spentByTxid === fill.txid && utxo.canonical) continue;
      await this.db.transaction(async (tx) => {
        await tx
          .update(schema.coveV3MarketTrades)
          .set({ canonical: false })
          .where(
            and(
              eq(schema.coveV3MarketTrades.network, this.config.network),
              eq(schema.coveV3MarketTrades.txid, fill.txid!),
            ),
          );
        await tx
          .update(schema.coveV3MarketFills)
          .set({ status: "REORGED", canonical: false, updatedAt: new Date() })
          .where(eq(schema.coveV3MarketFills.id, fill.id));
        await tx
          .update(schema.coveV3MarketListings)
          .set({ status: "REORGED", updatedAt: new Date() })
          .where(eq(schema.coveV3MarketListings.listingId, listing.listingId));
        await tx.insert(schema.coveV3MarketEvents).values({
          network: this.config.network,
          listingId: listing.listingId,
          fillId: fill.id,
          eventType: "FILL_REORGED",
          payloadJson: { txid: fill.txid },
        });
      });
      reorged++;
    }
    if (indexedGeneration !== undefined && confirmedFills.length < 200)
      this.reconciledGeneration = indexedGeneration;
    const openListings = await this.db
      .select()
      .from(schema.coveV3MarketListings)
      .where(
        and(
          eq(schema.coveV3MarketListings.network, this.config.network),
          inArray(schema.coveV3MarketListings.status, [
            "ACTIVE",
            "RESERVED",
            "BROADCAST",
            "REORGED",
          ]),
          sql`(${schema.coveV3MarketListings.status} in ('BROADCAST','REORGED') or exists (
            select 1 from cove_v3_token_utxos u where u.network = ${this.config.network} and u.txid = ${schema.coveV3MarketListings.sourceTxid}
              and u.vout = ${schema.coveV3MarketListings.sourceVout} and u.canonical and u.spent_by_txid is not null))`,
        ),
      )
      .orderBy(asc(schema.coveV3MarketListings.lastObservedAt))
      .limit(2);
    for (const listing of openListings) {
      await this.db
        .update(schema.coveV3MarketListings)
        .set({ lastObservedAt: new Date() })
        .where(eq(schema.coveV3MarketListings.listingId, listing.listingId));
      const utxo = await this.sourceUtxoRow(
        listing.sourceTxid,
        listing.sourceVout,
      );
      if (utxo && utxo.spentByTxid) {
        const ourTx = await this.listingFillTxid(
          listing.listingId,
          utxo.spentByTxid,
        );
        if (!ourTx) {
          await this.invalidateListing(
            listing.listingId,
            `spent by ${utxo.spentByTxid}`,
          );
          invalidated++;
        }
        continue;
      }
      const txout = await this.provider.getTxout(
        listing.sourceTxid,
        listing.sourceVout,
      );
      if (txout) {
        if (listing.status === "REORGED") {
          await this.db
            .update(schema.coveV3MarketListings)
            .set({ status: "ACTIVE", updatedAt: new Date() })
            .where(
              eq(schema.coveV3MarketListings.listingId, listing.listingId),
            );
        }
        continue;
      }
      const ourTxid = await this.latestFillTxid(listing.listingId);
      const isOurs = ourTxid !== null ? await this.inMempool(ourTxid) : false;
      if (isOurs === null) continue;
      if (isOurs && ourTxid !== null) {
        if (listing.status === "REORGED") {
          await this.db.transaction(async (tx) => {
            await tx
              .update(schema.coveV3MarketFills)
              .set({
                status: "BROADCAST",
                canonical: true,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(schema.coveV3MarketFills.listingId, listing.listingId),
                  eq(schema.coveV3MarketFills.txid, ourTxid),
                ),
              );
            await tx
              .update(schema.coveV3MarketListings)
              .set({ status: "BROADCAST", updatedAt: new Date() })
              .where(
                eq(schema.coveV3MarketListings.listingId, listing.listingId),
              );
            await tx.insert(schema.coveV3MarketEvents).values({
              network: this.config.network,
              listingId: listing.listingId,
              eventType: "FILL_REPENDING",
              payloadJson: { txid: ourTxid },
            });
          });
        }
        continue;
      }
      await this.invalidateListing(
        listing.listingId,
        "source spent in mempool by an external tx",
      );
      invalidated++;
    }
    expired += (await this.expireReservations(tip)).expired;
    return { expired, invalidated, confirmed, reorged };
  }
  async expireReservations(tip: bigint): Promise<{
    expired: number;
  }> {
    const now = new Date();
    let expired = 0;
    const expListings = await this.db
      .select()
      .from(schema.coveV3MarketListings)
      .where(
        and(
          eq(schema.coveV3MarketListings.network, this.config.network),
          eq(schema.coveV3MarketListings.status, "ACTIVE"),
          lte(schema.coveV3MarketListings.expiryHeight, tip),
        ),
      )
      .limit(200);
    for (const listing of expListings) {
      const changed = await this.db
        .update(schema.coveV3MarketListings)
        .set({ status: "EXPIRED", updatedAt: new Date() })
        .where(
          and(
            eq(schema.coveV3MarketListings.listingId, listing.listingId),
            eq(schema.coveV3MarketListings.status, "ACTIVE"),
          ),
        )
        .returning({ id: schema.coveV3MarketListings.id });
      if (changed.length) expired++;
    }
    const expFills = await this.db
      .select()
      .from(schema.coveV3MarketFills)
      .where(
        and(
          eq(schema.coveV3MarketFills.network, this.config.network),
          inArray(schema.coveV3MarketFills.status, [
            "RESERVED",
            "PSBT_BUILT",
            "BUYER_SIGNED",
          ]),
          lte(schema.coveV3MarketFills.reservationExpiresAt, now),
        ),
      )
      .limit(200);
    for (const fill of expFills) {
      const changed = await this.db.transaction(async (tx) => {
        await tx
          .select({ id: schema.coveV3MarketListings.id })
          .from(schema.coveV3MarketListings)
          .where(eq(schema.coveV3MarketListings.listingId, fill.listingId))
          .for("update");
        const expiredFill = await tx
          .update(schema.coveV3MarketFills)
          .set({ status: "EXPIRED", updatedAt: new Date() })
          .where(
            and(
              eq(schema.coveV3MarketFills.id, fill.id),
              inArray(schema.coveV3MarketFills.status, [
                "RESERVED",
                "PSBT_BUILT",
                "BUYER_SIGNED",
              ]),
              lte(schema.coveV3MarketFills.reservationExpiresAt, now),
            ),
          )
          .returning({ id: schema.coveV3MarketFills.id });
        if (!expiredFill.length) return false;
        await tx
          .update(schema.coveV3MarketListings)
          .set({ status: "ACTIVE", updatedAt: new Date() })
          .where(
            and(
              eq(schema.coveV3MarketListings.listingId, fill.listingId),
              eq(schema.coveV3MarketListings.status, "RESERVED"),
            ),
          );
        return true;
      });
      if (changed) expired++;
    }
    return { expired };
  }
  private async sourceUtxoRow(txid: string, vout: number) {
    const rows = await this.db
      .select()
      .from(schema.coveV3TokenUtxos)
      .where(
        and(
          eq(schema.coveV3TokenUtxos.network, this.config.network),
          eq(schema.coveV3TokenUtxos.txid, txid),
          eq(schema.coveV3TokenUtxos.vout, vout),
        ),
      );
    return rows[0] ?? null;
  }
  private async listingFillTxid(
    listingId: string,
    spentByTxid: string,
  ): Promise<boolean> {
    const rows = await this.db
      .select()
      .from(schema.coveV3MarketFills)
      .where(
        and(
          eq(schema.coveV3MarketFills.listingId, listingId),
          eq(schema.coveV3MarketFills.txid, spentByTxid),
        ),
      );
    return rows.length > 0;
  }
  private async latestFillTxid(listingId: string): Promise<string | null> {
    const rows = await this.db
      .select({ txid: schema.coveV3MarketFills.txid })
      .from(schema.coveV3MarketFills)
      .where(eq(schema.coveV3MarketFills.listingId, listingId))
      .orderBy(desc(schema.coveV3MarketFills.createdAt))
      .limit(1);
    return rows[0]?.txid ?? null;
  }
  private async inMempool(txid: string): Promise<boolean | null> {
    try {
      const observation = await this.provider.observeTransaction(txid, {
        signal: AbortSignal.timeout(5000),
        retry: false,
      });
      return observation.state === "mempool" ? true : null;
    } catch {
      return null;
    }
  }
  private async invalidateListing(
    listingId: string,
    reason: string,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .select({ id: schema.coveV3MarketListings.id })
        .from(schema.coveV3MarketListings)
        .where(eq(schema.coveV3MarketListings.listingId, listingId))
        .for("update");
      const submitting = await tx
        .select({ id: schema.coveV3MarketFills.id })
        .from(schema.coveV3MarketFills)
        .where(
          and(
            eq(schema.coveV3MarketFills.listingId, listingId),
            eq(schema.coveV3MarketFills.status, "SUBMITTING"),
          ),
        )
        .limit(1);
      if (submitting.length) return;
      await tx
        .update(schema.coveV3MarketListings)
        .set({
          status: "INVALIDATED",
          sellerPresignedPsbt: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.coveV3MarketListings.listingId, listingId));
      await tx
        .update(schema.coveV3MarketFills)
        .set({ status: "FAILED", failureReason: reason, updatedAt: new Date() })
        .where(
          and(
            eq(schema.coveV3MarketFills.listingId, listingId),
            inArray(schema.coveV3MarketFills.status, [
              "RESERVED",
              "PSBT_BUILT",
              "BUYER_SIGNED",
              "BROADCAST",
            ]),
          ),
        );
      await tx.insert(schema.coveV3MarketEvents).values({
        network: this.config.network,
        listingId,
        eventType: "LISTING_INVALIDATED",
        payloadJson: { reason },
      });
    });
  }
  private async ensureTrade(
    tx: DbTransaction,
    fill: FillSelect,
    listing: ListingSelect,
    blockHeight: bigint,
    blockHash: string | null,
  ): Promise<void> {
    const existing = await tx
      .select()
      .from(schema.coveV3MarketTrades)
      .where(
        and(
          eq(schema.coveV3MarketTrades.network, this.config.network),
          eq(schema.coveV3MarketTrades.txid, fill.txid!),
        ),
      );
    if (existing.length > 0) {
      await tx
        .update(schema.coveV3MarketTrades)
        .set({ canonical: true, blockHeight, blockHash, createdAt: new Date() })
        .where(
          and(
            eq(schema.coveV3MarketTrades.network, this.config.network),
            eq(schema.coveV3MarketTrades.txid, fill.txid!),
          ),
        );
      return;
    }
    await tx.insert(schema.coveV3MarketTrades).values({
      network: this.config.network,
      tokenId: listing.tokenId,
      listingId: listing.listingId,
      fillId: fill.id,
      sellerTokenScript: listing.sellerTokenScript,
      buyerTokenScript: fill.buyerTokenScript,
      amountAtoms: fill.amountAtoms,
      totalPriceSats: fill.totalPriceSats,
      marketFeeSats: fill.marketFeeSats,
      minerFeeSats: fill.minerFeeSats,
      txid: fill.txid!,
      blockHeight,
      blockHash,
      canonical: true,
    });
  }
  private buildTerms(listing: ListingSelect, fill: FillSelect): P2PFillTerms {
    return {
      listingId: listing.listingId,
      fillId: fill.id,
      tokenId: listing.tokenId,
      sourceTxid: listing.sourceTxid,
      sourceVout: listing.sourceVout,
      sourceAmountAtoms: listing.sourceAmountAtoms,
      sellerTokenScript: asBuffer(listing.sellerTokenScript),
      sellerTokenChangeScript: asBuffer(listing.sellerTokenChangeScript),
      sellerPayoutScript: asBuffer(listing.sellerPayoutScript),
      amountAtoms: listing.amountAtoms,
      totalPriceSats: listing.totalPriceSats,
      marketFeeSats: fill.marketFeeSats,
      minerFeeSats: fill.minerFeeSats,
      buyerTokenScript: asBuffer(fill.buyerTokenScript),
      buyerChangeScript: asBuffer(fill.buyerChangeScript),
      feeScript: this.config.feeScript,
      buyerFundInputs: fillFundInputs(fill).map((f) => ({
        txid: f.txid,
        vout: f.vout,
        script: asBuffer(f.script),
        valueSats: f.valueSats,
      })),
    };
  }
  private async loadView(
    tokenId: string,
    sourceTxid: string,
    sourceVout: number,
  ): Promise<CoveCanonicalView> {
    return loadCanonicalViewSnapshotFromDb({
      db: this.db,
      network: this.config.network,
      tokenId,
      relevantOutpoints: [{ txid: sourceTxid, vout: sourceVout }],
    });
  }
}
