import { type MainnetProfileValidationResult } from "./profile.js";
import {
  resolveMainnetProfile,
  TEST_ONLY_PROFILE_ENV,
} from "./committed-profile.js";
const TEST_ONLY_PATH = process.env[TEST_ONLY_PROFILE_ENV];
const MODE = process.argv.includes("--runtime")
  ? "runtime"
  : process.argv.includes("--static")
    ? "static"
    : "static";
function line(name: string, ok: boolean, detail: string): void {
  console.log(
    `${name.padEnd(36)} ${ok ? "PASS" : "FAIL"}${ok ? "" : ` — ${detail}`}`,
  );
}
function staticChecks(): {
  ready: boolean;
  validation: MainnetProfileValidationResult;
} {
  console.log("Cove V3 — mainnet readiness (STATIC)");
  let resolved;
  try {
    resolved = resolveMainnetProfile({
      network: "tooling",
      testOnlyPath: TEST_ONLY_PATH,
      baseDir: process.env.INIT_CWD ?? process.cwd(),
    });
  } catch (e) {
    console.log(`cannot load profile: ${(e as Error).message}`);
    console.log("");
    console.log("NOT_READY — profile unparsable");
    return {
      ready: false,
      validation: { ok: false, errors: ["UNPARSABLE_PROFILE"] },
    };
  }
  console.log(
    `profile source: ${resolved.source}${resolved.source === "test-only" ? ` (${TEST_ONLY_PATH}; test keys allowed)` : ""}`,
  );
  const { validation, profileHash } = resolved;
  const has = (prefix: string) =>
    validation.errors.some((e) => e.startsWith(prefix));
  line(
    "release manifest",
    false,
    "OWNER_DECISION_REQUIRED (release manifest hash committed post-ceremony)",
  );
  line("profile completeness", validation.ok, validation.errors.join("; "));
  line(
    "protocol profile match",
    !has("PROFILE_PROTOCOL_MISMATCH") &&
      !has("POLICY_VERSION_MISMATCH") &&
      !has("VAULT_PROFILE_MISMATCH") &&
      !has("CHAIN_IDENTITY_MISMATCH"),
    "carrier/anchor/supply/reserve/CMRs vs frozen constants",
  );
  line(
    "activation height",
    !has("INVALID_ACTIVATION_HEIGHT") &&
      !validation.errors.some(
        (e) => e === "OWNER_DECISION_REQUIRED: activationHeight",
      ),
    validation.errors.find((e) => e.includes("activationHeight")) ?? "",
  );
  line(
    "recovery profile",
    !has("INVALID_RECOVERY") &&
      !has("DUPLICATE_RECOVERY") &&
      !validation.errors.some(
        (e) =>
          e.includes("recovery.pubkeys") || e.includes("recovery.csvBlocks"),
      ),
    "2-of-3 or 1-of-1 keys + CSV",
  );
  line(
    "fee schedule",
    !has("INVALID_BUY_FEE") &&
      !has("INVALID_REDEEM_FEE") &&
      !has("INVALID_P2P_FEE") &&
      !validation.errors.some(
        (e) =>
          e.includes("buyFeeBps") ||
          e.includes("redeemFeeBps") ||
          e.includes("p2pFeeBps"),
      ),
    "buy/redeem/p2p bps + feeScript",
  );
  line(
    "canary wallet allowlist",
    !validation.errors.some((e) => e.includes("allowedWalletScripts")),
    "allowedWalletScripts",
  );
  line(
    "canary token policy",
    !validation.errors.some((e) => e.includes("allowedTokenIds")),
    "allowedTokenIds",
  );
  line(
    "canary caps",
    !has("INVALID_CANARY_CAP") &&
      !validation.errors.some(
        (e) =>
          e.includes("maxBackingSats") ||
          e.includes("maxSingleBuySats") ||
          e.includes("maxSingleRedeemPayoutSats") ||
          e.includes("maxP2pSettlementSats"),
      ),
    "backing/buy/redeem/P2P caps",
  );
  console.log(`profile hash: ${profileHash}`);
  console.log("");
  if (validation.ok) {
    console.log(
      "STATIC_PROFILE_READY (profile complete; runtime health still required for canary)",
    );
  } else {
    const owner = validation.errors.filter((e) =>
      e.startsWith("OWNER_DECISION_REQUIRED"),
    );
    console.log(
      `READY_EXCEPT_FOR_OPERATOR_CEREMONY — ${owner.length} owner decision(s) + ${validation.errors.length - owner.length} other static failure(s) remain`,
    );
  }
  return { ready: validation.ok, validation };
}
function runtimeChecks(): void {
  console.log("Cove V3 — mainnet readiness (RUNTIME)");
  console.log(
    "runtime readiness is not yet wired (primary/secondary Core, indexer, worker, Guardian service).",
  );
  console.log("");
  console.log("NOT_READY — runtime services not configured");
}
if (MODE === "runtime") {
  staticChecks();
  console.log("");
  runtimeChecks();
} else {
  staticChecks();
}
