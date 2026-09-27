import type { Sats } from "@crclaunch/curve";
export const DUST_RELAY_FEE_SAT_PER_KVB = 3000n;
export function isWitnessProgram(script: Uint8Array): boolean {
  if (script.length < 4) return false;
  const first = script[0]!;
  const len = script[1]!;
  const isVersion = first === 0x00 || (first >= 0x51 && first <= 0x60);
  if (!isVersion) return false;
  return len >= 2 && len <= 40 && script.length === 2 + len;
}
export function isP2TR(script: Uint8Array): boolean {
  return script.length === 34 && script[0] === 0x51 && script[1] === 0x20;
}
export function isP2WPKH(script: Uint8Array): boolean {
  return script.length === 22 && script[0] === 0x00 && script[1] === 0x14;
}
export function dustThreshold(
  script: Uint8Array,
  dustRelayFeeSatPerKvB: Sats = DUST_RELAY_FEE_SAT_PER_KVB,
): Sats {
  if (script[0] === 0x6a) return 0n;
  let nSize = 8n + 1n + BigInt(script.length);
  nSize += isWitnessProgram(script) ? 67n : 148n;
  return (nSize * dustRelayFeeSatPerKvB) / 1000n;
}
export function isDustSafe(netSats: Sats, script: Uint8Array): boolean {
  return netSats >= dustThreshold(script);
}
