import * as bitcoin from "bitcoinjs-lib";
import {
  checkListingSignature,
  psbtInputFor,
  unfinalizeKeyInputs,
  SIGHASH_SINGLE_ANYONECANPAY,
} from "@crclaunch/bitcoin";
import { TOKEN_CARRIER_SATS } from "@crclaunch/cove-covenant";
import { encodeTransferV2 } from "@crclaunch/cove-wire";
import { dustThreshold } from "@crclaunch/cove-economics";
import { MarketError } from "./errors.js";
export const LISTING_TX_VERSION = 2;
export const LISTING_LOCKTIME = 0;
export const LISTING_SEQUENCE = 0xffffffff;
export { SIGHASH_SINGLE_ANYONECANPAY };
export const FILL_SELLER_INPUT = 1;
export const FILL_PAYOUT_VOUT = 1;
export const FILL_BUYER_CARRIER_VOUT = 2;
export const FILL_FEE_VOUT = 3;
export const FILL_BUYER_CHANGE_VOUT = 4;
export interface ListingSource {
  txid: string;
  vout: number;
  script: Buffer;
  valueSats: bigint;
  publicKey?: Buffer;
}
export interface SellerPresig {
  tapKeySig?: Buffer;
  partialSig?: {
    pubkey: Buffer;
    signature: Buffer;
  }[];
}
export function buildListingPsbt(params: {
  network: bitcoin.networks.Network;
  source: ListingSource;
  payoutScript: Buffer;
  priceSats: bigint;
}): bitcoin.Psbt {
  const psbt = new bitcoin.Psbt({ network: params.network });
  psbt.setVersion(LISTING_TX_VERSION);
  psbt.setLocktime(LISTING_LOCKTIME);
  psbt.addInput({
    ...psbtInputFor(params.source, params.network),
    sequence: LISTING_SEQUENCE,
    sighashType: SIGHASH_SINGLE_ANYONECANPAY,
  });
  psbt.addOutput({
    script: params.payoutScript,
    value: Number(params.priceSats),
  });
  return psbt;
}
export function verifyListingPsbt(
  psbtBase64: string,
  expected: {
    network: bitcoin.networks.Network;
    source: ListingSource;
    payoutScript: Buffer;
    priceSats: bigint;
  },
): SellerPresig {
  let psbt: bitcoin.Psbt;
  try {
    psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network: expected.network });
  } catch (e) {
    throw new MarketError(
      "LISTING_BAD_SIGNATURE",
      `cannot parse the signed listing: ${(e as Error).message}`,
    );
  }
  unfinalizeKeyInputs(psbt);
  const want = buildListingPsbt(expected);
  const got = psbt.data.globalMap.unsignedTx.toBuffer();
  if (!got.equals(want.data.globalMap.unsignedTx.toBuffer())) {
    throw new MarketError(
      "LISTING_BAD_SIGNATURE",
      "the signed listing is not the listing for these terms (carrier, payout, price, version, locktime or sequence differ)",
    );
  }
  const input = psbt.data.inputs[0]!;
  const wu = input.witnessUtxo;
  if (
    !wu ||
    !Buffer.from(wu.script).equals(expected.source.script) ||
    BigInt(wu.value) !== expected.source.valueSats
  ) {
    throw new MarketError(
      "LISTING_BAD_SIGNATURE",
      "the signed listing does not describe the carrier being sold",
    );
  }
  const check = checkListingSignature(psbt, 0);
  if (!check.ok) {
    throw new MarketError(
      check.reason === "NOT_SIGHASH_ALL"
        ? "UNSAFE_SIGHASH"
        : "LISTING_BAD_SIGNATURE",
      `listing signature: ${check.detail}`,
    );
  }
  if (input.tapKeySig) return { tapKeySig: Buffer.from(input.tapKeySig) };
  return {
    partialSig: input.partialSig!.map((p) => ({
      pubkey: Buffer.from(p.pubkey),
      signature: Buffer.from(p.signature),
    })),
  };
}
export function presigOf(
  psbtBase64: string,
  network: bitcoin.networks.Network,
): SellerPresig {
  const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network });
  unfinalizeKeyInputs(psbt);
  const input = psbt.data.inputs[0]!;
  if (input.tapKeySig) return { tapKeySig: Buffer.from(input.tapKeySig) };
  if (input.partialSig?.length) {
    return {
      partialSig: input.partialSig.map((p) => ({
        pubkey: Buffer.from(p.pubkey),
        signature: Buffer.from(p.signature),
      })),
    };
  }
  throw new MarketError(
    "LISTING_BAD_SIGNATURE",
    "stored listing has no signature",
  );
}
export interface FillFundInput {
  txid: string;
  vout: number;
  script: Buffer;
  valueSats: bigint;
  publicKey?: Buffer;
}
export function buildPresignedFillPsbt(params: {
  network: bitcoin.networks.Network;
  tokenId: Buffer;
  seller: ListingSource & {
    amountAtoms: bigint;
  };
  payoutScript: Buffer;
  priceSats: bigint;
  buyerTokenScript: Buffer;
  fundInputs: FillFundInput[];
  buyerChangeScript: Buffer;
  feeScript: Buffer;
  marketFeeSats: bigint;
  minerFeeSats: bigint;
}): {
  psbt: bitcoin.Psbt;
  minerFeeSats: bigint;
  changeSats: bigint;
} {
  if (params.fundInputs.length === 0) {
    throw new MarketError(
      "BUYER_FUNDS_INSUFFICIENT",
      "a purchase needs at least one funding coin",
    );
  }
  const psbt = new bitcoin.Psbt({ network: params.network });
  psbt.setVersion(LISTING_TX_VERSION);
  psbt.setLocktime(LISTING_LOCKTIME);
  const [first, ...rest] = params.fundInputs;
  psbt.addInput(psbtInputFor(first!, params.network));
  psbt.addInput({
    ...psbtInputFor(params.seller, params.network),
    sequence: LISTING_SEQUENCE,
  });
  for (const f of rest) psbt.addInput(psbtInputFor(f, params.network));
  const wire = encodeTransferV2({
    tokenId: params.tokenId,
    allocations: [
      { vout: FILL_BUYER_CARRIER_VOUT, amount: params.seller.amountAtoms },
    ],
  });
  psbt.addOutput({
    script: Buffer.concat([Buffer.from([0x6a, wire.length]), wire]),
    value: 0,
  });
  psbt.addOutput({
    script: params.payoutScript,
    value: Number(params.priceSats),
  });
  psbt.addOutput({
    script: params.buyerTokenScript,
    value: Number(TOKEN_CARRIER_SATS),
  });
  psbt.addOutput({
    script: params.feeScript,
    value: Number(params.marketFeeSats),
  });
  const totalIn =
    params.fundInputs.reduce((s, f) => s + f.valueSats, 0n) +
    params.seller.valueSats;
  const spent =
    params.priceSats +
    TOKEN_CARRIER_SATS +
    params.marketFeeSats +
    params.minerFeeSats;
  const change = totalIn - spent;
  if (change < 0n)
    throw new MarketError("BUYER_FUNDS_INSUFFICIENT", `short ${-change} sats`);
  if (change >= dustThreshold(params.buyerChangeScript)) {
    psbt.addOutput({ script: params.buyerChangeScript, value: Number(change) });
    return { psbt, minerFeeSats: params.minerFeeSats, changeSats: change };
  }
  return { psbt, minerFeeSats: params.minerFeeSats + change, changeSats: 0n };
}
export function attachSellerPresig(
  psbt: bitcoin.Psbt,
  presig: SellerPresig,
): void {
  if (presig.tapKeySig)
    psbt.updateInput(FILL_SELLER_INPUT, { tapKeySig: presig.tapKeySig });
  else if (presig.partialSig)
    psbt.updateInput(FILL_SELLER_INPUT, { partialSig: presig.partialSig });
  else
    throw new MarketError(
      "LISTING_BAD_SIGNATURE",
      "no seller signature to attach",
    );
}
