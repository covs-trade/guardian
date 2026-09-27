import {
  resolveMainnetProfile,
  TEST_ONLY_PROFILE_ENV,
} from "@crclaunch/cove-mainnet";
import { runRuntimeReadiness } from "./readiness-cli.js";
const args = process.argv.slice(2);
const doStatic = args.includes("--static") || args.length === 0;
const doRuntime = args.includes("--runtime") || args.length === 0;
const TEST_ONLY_PATH = process.env[TEST_ONLY_PROFILE_ENV];
function line(name: string, ok: boolean, detail = ""): void {
  console.log(
    `${name.padEnd(32)} ${ok ? "PASS" : "FAIL"}${ok ? "" : ` — ${detail}`}`,
  );
}
function staticSection(): boolean {
  console.log("── STATIC ──");
  try {
    const { validation, profileHash, source } = resolveMainnetProfile({
      network: "tooling",
      testOnlyPath: TEST_ONLY_PATH,
      baseDir: process.env.INIT_CWD ?? process.cwd(),
      feeAddress: process.env.COVE_FEE_ADDRESS || undefined,
    });
    console.log(
      `profile source: ${source}${source === "test-only" ? ` (${TEST_ONLY_PATH}; test keys allowed)` : ""}`,
    );
    line(
      "profile completeness",
      validation.ok,
      validation.errors.slice(0, 3).join("; "),
    );
    line(
      "protocol profile match",
      !validation.errors.some((e) => e.includes("PROFILE_PROTOCOL_MISMATCH")),
    );
    const owner = validation.errors.filter((e) =>
      e.startsWith("OWNER_DECISION_REQUIRED"),
    );
    console.log(`owner decisions remaining: ${owner.length}`);
    if (validation.ok) console.log(`profile hash: ${profileHash}`);
    return validation.ok;
  } catch (e) {
    console.log(`cannot load profile: ${(e as Error).message}`);
    return false;
  }
}
async function main(): Promise<void> {
  console.log("Cove V3 — mainnet readiness");
  let staticReady = true;
  if (doStatic) staticReady = staticSection();
  let state = "READY_EXCEPT_FOR_OPERATOR_CEREMONY";
  if (doRuntime) {
    console.log("── RUNTIME ──");
    const r = await runRuntimeReadiness(
      process.env as Record<string, string | undefined>,
    );
    const rd = r.readiness;
    line("primary Core", rd.primaryCoreHealthy);
    line("secondary Core", rd.secondaryCoreHealthy);
    line("Core agreement", rd.coreAgreement, r.coreAgreementDetail ?? "");
    line("Guardian reachable", rd.guardianHealthy);
    line("Guardian profile hash", rd.guardianProfileHashMatches);
    line("Guardian key", rd.guardianKeyMatches);
    line("custody backend", rd.custodyBackendReady);
    line("audit", rd.auditHealthy);
    line("signing journal", rd.signingJournalHealthy);
    console.log(`stage: ${rd.stage}`);
    console.log(`profile hash: ${r.profileHash}`);
    state = r.state;
  } else if (!staticReady) {
    state = "READY_EXCEPT_FOR_OPERATOR_CEREMONY";
  } else {
    state = "READY_EXCEPT_FOR_OPERATOR_CEREMONY";
  }
  console.log("");
  console.log(state);
  if (
    state !== "READY_FOR_CONTROLLED_MAINNET_CANARY" &&
    state !== "READY_EXCEPT_FOR_OPERATOR_CEREMONY"
  ) {
    process.exitCode = 1;
  }
}
main().catch((e) => {
  console.error(
    "readiness failed:",
    e instanceof Error ? e.message : String(e),
  );
  process.exit(1);
});
