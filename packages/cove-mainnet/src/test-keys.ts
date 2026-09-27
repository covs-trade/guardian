import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);
export const KNOWN_TEST_KEY_BYTES = [
  0x42, 0x43, 0x44, 0x46, 0x47, 0x48, 0x49, 0x51, 0x52, 0x53,
] as const;
export function isKnownTestPrivateKeyHex(hex: string): boolean {
  const h = hex.toLowerCase();
  return KNOWN_TEST_KEY_BYTES.some(
    (b) => h === b.toString(16).padStart(2, "0").repeat(32),
  );
}
interface Derived {
  xOnly: Set<string>;
  scripts: Set<string>;
}
let derived: Derived | null = null;
function testKeyMaterial(): Derived {
  if (derived) return derived;
  const xOnly = new Set<string>();
  const scripts = new Set<string>();
  for (const b of KNOWN_TEST_KEY_BYTES) {
    const pubkey = Buffer.from(ecc.pointFromScalar(Buffer.alloc(32, b), true)!);
    const x = pubkey.subarray(1);
    xOnly.add(x.toString("hex"));
    const p2wpkh = bitcoin.payments.p2wpkh({ pubkey });
    scripts.add(p2wpkh.output!.toString("hex"));
    scripts.add(
      bitcoin.payments.p2tr({ internalPubkey: x }).output!.toString("hex"),
    );
    scripts.add(bitcoin.payments.p2pkh({ pubkey }).output!.toString("hex"));
    scripts.add(
      bitcoin.payments.p2sh({ redeem: p2wpkh }).output!.toString("hex"),
    );
  }
  derived = { xOnly, scripts };
  return derived;
}
export function isKnownTestXOnly(hex: string): boolean {
  return testKeyMaterial().xOnly.has(hex.toLowerCase());
}
export function isKnownTestScript(hex: string): boolean {
  return testKeyMaterial().scripts.has(hex.toLowerCase());
}
