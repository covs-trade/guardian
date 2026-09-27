import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
export const MINT_CMR_V1 =
  "118425967f4aed4fb528bd06a0f7a99a318675e819e837a2c452df6199d359b2";
export const REDEEM_CMR_V2 =
  "a15ac4cbc450ac2dd113b1a9de178450ccc893a5213d8a2f56471fcd9aa274b7";
export const MINT_CMR_CAP840 =
  "0b594eb3fadec17b45bb1d245ae18f8c512a1ba42751f820cd28351ced6c8377";
export const MINT_CMR_CAP1B =
  "ccdb02000fdb372bfa2e166b9fe0192715d555fc5720f8008ee741fe1a0d58ec";
export const MINT_CMR =
  "7fb27adf2db5458882daf976ba9325815f111b2f3b16eedb72e75f96de4269b2";
export const REDEEM_CMR =
  "37e681b3e70a34acc3b38680c06fbe4f1b2799bede2607c6c9ed7fcac8c95d56";
export interface MintWitness {
  amount: bigint;
  prevSupply: bigint;
  nextSupply: bigint;
  prevReserve: bigint;
  nextReserve: bigint;
  contribution: bigint;
}
export interface RedeemWitness {
  amount: bigint;
  oldSupply: bigint;
  newSupply: bigint;
  oldBacking: bigint;
  newBacking: bigint;
  payout: bigint;
}
export type SimplicityFailureCode =
  | "SIMPLICITY_BINARY_MISSING"
  | "SIMPLICITY_EXECUTION_ERROR"
  | "SIMPLICITY_TIMEOUT"
  | "SIMPLICITY_MALFORMED_RESULT"
  | "CMR_MISMATCH"
  | "SIMPLICITY_REJECTED";
export interface SimplicityExecutionResult {
  policy: "MINT" | "REDEEM";
  expectedCmr: string;
  actualCmr: string | null;
  result: "PASS" | "FAIL";
  failure: SimplicityFailureCode | null;
}
export const SIMPLICITY_TIMEOUT_MS = 10000;
function binaryPath(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const release = join(
    here,
    "..",
    "rust",
    "target",
    "release",
    "cove-simplicity",
  );
  const debug = join(here, "..", "rust", "target", "debug", "cove-simplicity");
  if (existsSync(release)) return release;
  if (existsSync(debug)) return debug;
  return null;
}
export function isSimplicityAvailable(): boolean {
  return binaryPath() !== null;
}
function mintWitnessString(w: MintWitness): string {
  return `mod witness { const AMOUNT: u64 = ${w.amount}; const PREV_SUPPLY: u64 = ${w.prevSupply}; const NEXT_SUPPLY: u64 = ${w.nextSupply}; const PREV_RESERVE: u64 = ${w.prevReserve}; const NEXT_RESERVE: u64 = ${w.nextReserve}; const CONTRIBUTION: u64 = ${w.contribution}; }`;
}
function redeemWitnessString(w: RedeemWitness): string {
  return `mod witness { const AMOUNT: u64 = ${w.amount}; const OLD_SUPPLY: u64 = ${w.oldSupply}; const NEW_SUPPLY: u64 = ${w.newSupply}; const OLD_BACKING: u64 = ${w.oldBacking}; const NEW_BACKING: u64 = ${w.newBacking}; const PAYOUT: u64 = ${w.payout}; }`;
}
interface ExecOutput {
  cmr: string;
  result: string;
}
export interface SimplicityExecOptions {
  timeoutMs?: number;
  binaryPath?: string | null;
}
async function executeStrict(
  policy: "MINT" | "REDEEM",
  rustPolicy: "mint" | "redeem",
  witness: string,
  expectedCmr: string,
  opts: SimplicityExecOptions,
): Promise<SimplicityExecutionResult> {
  const base: SimplicityExecutionResult = {
    policy,
    expectedCmr,
    actualCmr: null,
    result: "FAIL",
    failure: null,
  };
  const bin = opts.binaryPath !== undefined ? opts.binaryPath : binaryPath();
  if (bin === null) {
    return { ...base, failure: "SIMPLICITY_BINARY_MISSING" };
  }
  const execFileAsync = promisify(execFile);
  let stdout: string;
  try {
    const out = await execFileAsync(bin, ["exec", rustPolicy, witness], {
      encoding: "utf8",
      maxBuffer: 1000000,
      timeout: opts.timeoutMs ?? SIMPLICITY_TIMEOUT_MS,
    });
    stdout = out.stdout as string;
  } catch (e) {
    const err = e as NodeJS.ErrnoException & {
      killed?: boolean;
      signal?: string;
      code?: string | number | null;
    };
    if (
      err.killed === true ||
      err.signal === "SIGTERM" ||
      err.code === "ETIMEDOUT"
    ) {
      return { ...base, failure: "SIMPLICITY_TIMEOUT" };
    }
    return { ...base, failure: "SIMPLICITY_EXECUTION_ERROR" };
  }
  let parsed: ExecOutput;
  try {
    parsed = JSON.parse(stdout) as ExecOutput;
  } catch {
    return { ...base, failure: "SIMPLICITY_MALFORMED_RESULT" };
  }
  if (typeof parsed.cmr !== "string" || typeof parsed.result !== "string") {
    return { ...base, failure: "SIMPLICITY_MALFORMED_RESULT" };
  }
  if (parsed.result !== "PASS" && parsed.result !== "FAIL") {
    return { ...base, failure: "SIMPLICITY_MALFORMED_RESULT" };
  }
  const actualCmr = parsed.cmr;
  if (actualCmr !== expectedCmr) {
    return { ...base, actualCmr, failure: "CMR_MISMATCH" };
  }
  if (parsed.result === "PASS") {
    return { ...base, actualCmr, result: "PASS", failure: null };
  }
  return { ...base, actualCmr, result: "FAIL", failure: "SIMPLICITY_REJECTED" };
}
export function executeMintV3(
  witness: MintWitness,
  opts: SimplicityExecOptions = {},
): Promise<SimplicityExecutionResult> {
  return executeStrict(
    "MINT",
    "mint",
    mintWitnessString(witness),
    MINT_CMR,
    opts,
  );
}
export function executeRedeemV3(
  witness: RedeemWitness,
  opts: SimplicityExecOptions = {},
): Promise<SimplicityExecutionResult> {
  return executeStrict(
    "REDEEM",
    "redeem",
    redeemWitnessString(witness),
    REDEEM_CMR,
    opts,
  );
}
