import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";
import { MarketError } from "../errors.js";
import type { CancellationV1, ListingV1 } from "../types.js";
import {
  cancellationMessageToSign,
  listingMessageToSign,
  reservationMessageToSign,
  type ReservationV1,
} from "./hash.js";
bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);
const ECPair = ECPairFactory(ecc);
function isP2WPKH(script: Buffer): boolean {
  return script.length === 22 && script[0] === 0x00 && script[1] === 0x14;
}
function isP2TR(script: Buffer): boolean {
  return script.length === 34 && script[0] === 0x51 && script[1] === 0x20;
}
function compactSize(n: number): Buffer {
  if (n < 0xfd) return Buffer.from([n]);
  if (n <= 0xffff) {
    const b = Buffer.alloc(3);
    b[0] = 0xfd;
    b.writeUInt16LE(n, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = 0xfe;
  b.writeUInt32LE(n, 1);
  return b;
}
function readCompactSize(
  buf: Buffer,
  offset: number,
): {
  value: number;
  len: number;
} {
  const first = buf[offset];
  if (first === undefined) throw new Error("truncated");
  if (first < 0xfd) return { value: first, len: 1 };
  if (first === 0xfd) return { value: buf.readUInt16LE(offset + 1), len: 3 };
  if (first === 0xfe) return { value: buf.readUInt32LE(offset + 1), len: 5 };
  throw new Error("oversized");
}
function encodeWitness(stack: Buffer[]): string {
  return Buffer.concat([
    compactSize(stack.length),
    ...stack.flatMap((w) => [compactSize(w.length), w]),
  ]).toString("base64");
}
function decodeWitness(signatureB64: string): Buffer[] {
  const buf = Buffer.from(signatureB64, "base64");
  let offset = 0;
  const count = readCompactSize(buf, offset);
  offset += count.len;
  const stack: Buffer[] = [];
  for (let i = 0; i < count.value; i++) {
    const len = readCompactSize(buf, offset);
    offset += len.len;
    if (offset + len.value > buf.length) throw new Error("truncated");
    stack.push(buf.subarray(offset, offset + len.value));
    offset += len.value;
  }
  if (offset !== buf.length) throw new Error("trailing bytes");
  return stack;
}
export function bip322MessageHash(message: string): Buffer {
  const tag = bitcoin.crypto.sha256(
    Buffer.from("BIP0322-signed-message", "utf8"),
  );
  return bitcoin.crypto.sha256(
    Buffer.concat([tag, tag, Buffer.from(message, "utf8")]),
  );
}
function toSignTx(scriptPubKey: Buffer, message: string): bitcoin.Transaction {
  const toSpend = new bitcoin.Transaction();
  toSpend.version = 0;
  toSpend.locktime = 0;
  toSpend.addInput(
    Buffer.alloc(32),
    0xffffffff,
    0,
    bitcoin.script.compile([bitcoin.opcodes.OP_0!, bip322MessageHash(message)]),
  );
  toSpend.addOutput(scriptPubKey, 0);
  const toSign = new bitcoin.Transaction();
  toSign.version = 0;
  toSign.locktime = 0;
  toSign.addInput(toSpend.getHash(), 0, 0);
  toSign.addOutput(bitcoin.script.compile([bitcoin.opcodes.OP_RETURN!]), 0);
  return toSign;
}
function p2wpkhSighash(
  toSign: bitcoin.Transaction,
  program: Buffer,
  hashType: number,
): Buffer {
  const scriptCode = bitcoin.payments.p2pkh({ hash: program }).output!;
  return toSign.hashForWitnessV0(0, scriptCode, 0, hashType);
}
function p2trSighash(
  toSign: bitcoin.Transaction,
  scriptPubKey: Buffer,
  hashType: number,
): Buffer {
  return toSign.hashForWitnessV1(0, [scriptPubKey], [0], hashType);
}
export function signBip322P2wpkh(
  privKey: Buffer,
  scriptPubKey: Buffer,
  message: string,
): string {
  const key = ECPair.fromPrivateKey(privKey);
  const hashType = bitcoin.Transaction.SIGHASH_ALL;
  const sighash = p2wpkhSighash(
    toSignTx(scriptPubKey, message),
    scriptPubKey.subarray(2),
    hashType,
  );
  const sig = bitcoin.script.signature.encode(
    Buffer.from(key.sign(sighash)),
    hashType,
  );
  return encodeWitness([sig, Buffer.from(key.publicKey)]);
}
export function signBip322P2tr(
  privKey: Buffer,
  message: string,
): {
  scriptPubKey: Buffer;
  signatureB64: string;
} {
  const key = ECPair.fromPrivateKey(privKey);
  const internal = Buffer.from(key.publicKey.subarray(1));
  const payment = bitcoin.payments.p2tr({ internalPubkey: internal });
  const tweak = bitcoin.crypto.taggedHash("TapTweak", internal);
  const evenPriv =
    key.publicKey[0] === 0x03
      ? Buffer.from(ecc.privateNegate(privKey))
      : privKey;
  const tweaked = ecc.privateAdd(evenPriv, tweak);
  if (!tweaked) throw new Error("invalid tweak");
  const sighash = p2trSighash(
    toSignTx(payment.output!, message),
    payment.output!,
    bitcoin.Transaction.SIGHASH_DEFAULT,
  );
  const sig = Buffer.from(ecc.signSchnorr(sighash, tweaked));
  return { scriptPubKey: payment.output!, signatureB64: encodeWitness([sig]) };
}
export function verifyBip322(
  scriptPubKey: Buffer,
  message: string,
  signatureB64: string,
): boolean {
  try {
    const witness = decodeWitness(signatureB64);
    const toSign = toSignTx(scriptPubKey, message);
    if (isP2WPKH(scriptPubKey)) {
      if (witness.length !== 2) return false;
      const [sigBytes, pubkey] = witness as [Buffer, Buffer];
      if (pubkey.length !== 33) return false;
      if (!bitcoin.crypto.hash160(pubkey).equals(scriptPubKey.subarray(2)))
        return false;
      const decoded = bitcoin.script.signature.decode(sigBytes);
      if (decoded.hashType !== bitcoin.Transaction.SIGHASH_ALL) return false;
      return ecc.verify(
        p2wpkhSighash(toSign, scriptPubKey.subarray(2), decoded.hashType),
        pubkey,
        decoded.signature,
      );
    }
    if (isP2TR(scriptPubKey)) {
      if (witness.length !== 1) return false;
      const sigBytes = witness[0]!;
      let hashType: number;
      if (sigBytes.length === 64)
        hashType = bitcoin.Transaction.SIGHASH_DEFAULT;
      else if (
        sigBytes.length === 65 &&
        sigBytes[64] === bitcoin.Transaction.SIGHASH_ALL
      )
        hashType = bitcoin.Transaction.SIGHASH_ALL;
      else return false;
      const sighash = p2trSighash(toSign, scriptPubKey, hashType);
      return ecc.verifySchnorr(
        sighash,
        scriptPubKey.subarray(2),
        sigBytes.subarray(0, 64),
      );
    }
    return false;
  } catch {
    return false;
  }
}
export const verifyBip322P2wpkh = verifyBip322;
function requireSupported(scriptHex: string, who: string): Buffer {
  const script = Buffer.from(scriptHex, "hex");
  if (!isP2WPKH(script) && !isP2TR(script)) {
    throw new MarketError(
      "LISTING_BAD_SIGNATURE",
      `${who} address must be native segwit (P2WPKH) or taproot (P2TR)`,
    );
  }
  return script;
}
export function verifyListingAuthorization(
  l: ListingV1,
  signatureB64: string,
): boolean {
  return verifyBip322(
    requireSupported(l.sellerTokenScript, "seller"),
    listingMessageToSign(l),
    signatureB64,
  );
}
export function verifyCancellationAuthorization(
  l: ListingV1,
  c: CancellationV1,
  signatureB64: string,
): boolean {
  return verifyBip322(
    requireSupported(l.sellerTokenScript, "seller"),
    cancellationMessageToSign(c),
    signatureB64,
  );
}
export function verifyReservationAuthorization(
  r: ReservationV1,
  signatureB64: string,
): boolean {
  return verifyBip322(
    requireSupported(r.buyerTokenScript, "buyer"),
    reservationMessageToSign(r),
    signatureB64,
  );
}
