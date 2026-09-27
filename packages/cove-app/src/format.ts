import { ATOMS_PER_TOKEN } from "@crclaunch/curve";
import { AppError } from "./errors.js";
export function parseDisplayTokens(input: string): bigint {
  const s = input.trim();
  if (!/^\d+(\.\d+)?$/.test(s))
    throw new AppError(
      "TOKEN_AMOUNT_INVALID",
      "amount must be a non-negative decimal",
    );
  const parts = s.split(".");
  const whole = parts[0]!;
  const frac = parts[1] ?? "";
  if (frac.length > 8)
    throw new AppError(
      "TOKEN_AMOUNT_INVALID",
      "token amount has more than 8 decimals",
    );
  const wholeAtoms = BigInt(whole) * ATOMS_PER_TOKEN;
  const fracAtoms = BigInt((frac + "00000000").slice(0, 8));
  return wholeAtoms + fracAtoms;
}
export function parseSats(input: string): bigint {
  const s = input.trim();
  if (!/^\d+$/.test(s))
    throw new AppError(
      "TOKEN_AMOUNT_INVALID",
      "sats must be a non-negative integer",
    );
  return BigInt(s);
}
export function parseBtc(input: string): bigint {
  const s = input.trim();
  if (!/^\d+(\.\d+)?$/.test(s))
    throw new AppError(
      "TOKEN_AMOUNT_INVALID",
      "BTC amount must be a non-negative decimal",
    );
  const parts = s.split(".");
  const whole = parts[0]!;
  const frac = parts[1] ?? "";
  if (frac.length > 8)
    throw new AppError(
      "TOKEN_AMOUNT_INVALID",
      "BTC amount has more than 8 decimals",
    );
  return BigInt(whole) * 100000000n + BigInt((frac + "00000000").slice(0, 8));
}
export function atomsToDisplay(atoms: bigint): string {
  const whole = atoms / ATOMS_PER_TOKEN;
  const frac = atoms % ATOMS_PER_TOKEN;
  if (frac === 0n) return whole.toString();
  return `${whole}.${frac.toString().padStart(8, "0").replace(/0+$/, "")}`;
}
export function formatTokens(atoms: bigint): string {
  const d = atomsToDisplay(atoms);
  return `${d} tokens`;
}
export function formatSats(sats: bigint): string {
  return `${sats.toLocaleString("en-US")} sats`;
}
export function formatBtc(sats: bigint): string {
  const sign = sats < 0n ? "-" : "";
  const abs = sats < 0n ? -sats : sats;
  const whole = abs / 100000000n;
  const frac = abs % 100000000n;
  const fracStr = frac.toString().padStart(8, "0").replace(/0+$/, "");
  return `${sign}${whole.toString()}${fracStr ? "." + fracStr : ""} BTC`;
}
