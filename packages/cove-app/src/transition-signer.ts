import type { Database } from "@crclaunch/db";
import {
  LocalGuardianTransitionSigner,
  RemoteGuardianTransitionSigner,
  HttpGuardianTransport,
  localSigningBackend,
  GuardianV3Signer,
  type GuardianRiskPolicy,
  type GuardianTransitionSigner,
  type GuardianTransport,
} from "@crclaunch/cove-guardian/v3";
import { PostgresSigningJournal } from "./journal.js";
import { PostgresGuardianAudit } from "./audit.js";
import { AppError } from "./errors.js";
import type { V3AppConfig } from "./config.js";
function failClosedTransport(): GuardianTransport {
  return {
    health: async () => {
      throw new Error("guardian endpoint not configured");
    },
    sign: async () => {
      throw new Error("guardian endpoint not configured");
    },
  };
}
export const DEV_RISK_POLICY: GuardianRiskPolicy = {
  maxGrossSats: 200000n,
  maxMintAtoms: 1000000000n * 100000000n,
  minMintGrossSats: 0n,
  maxRedeemPayoutSats: 1000000n,
  maxBackingSats: 100000000000000n,
  maxMinerFeeSats: 20000n,
  allowedTokenIds: [],
  enforceTokenAllowlist: false,
};
export function buildAppTransitionSigner(
  db: Database,
  config: V3AppConfig,
): GuardianTransitionSigner {
  if (config.network !== "mainnet") {
    if (!config.guardianPrivateKey) {
      throw new AppError(
        "GUARDIAN_UNAVAILABLE",
        "local Guardian key required for non-mainnet signing",
      );
    }
    const signer = GuardianV3Signer.fromPrivateKey(config.guardianPrivateKey);
    return new LocalGuardianTransitionSigner(
      localSigningBackend(signer),
      new PostgresSigningJournal(db),
      new PostgresGuardianAudit(
        db,
        config.recoveryProfile?.profileVersion ?? "COVE_V3_VAULT_PROFILE_DEV1",
      ),
      {
        ...DEV_RISK_POLICY,
        maxMinerFeeSats: config.maxMinerFeeSats,
        ...(config.mintLimits?.maxGrossSats != null
          ? { maxGrossSats: config.mintLimits.maxGrossSats }
          : {}),
      },
    );
  }
  const transport: GuardianTransport = config.guardianEndpoint
    ? new HttpGuardianTransport(
        config.guardianEndpoint,
        config.guardianAuthToken ?? "",
      )
    : failClosedTransport();
  return new RemoteGuardianTransitionSigner(
    transport,
    config.mainnetProfileHash ?? "",
    config.guardianXOnly.toString("hex"),
  );
}
export function watchGuardianAgreement(
  signer: GuardianTransitionSigner,
  config: V3AppConfig,
  opts: {
    service: string;
    retryMs?: number;
    onMismatch?: (reason: string) => void;
  } = { service: "app" },
): void {
  if (config.network !== "mainnet") return;
  const retryMs = opts.retryMs ?? 15000;
  const onMismatch =
    opts.onMismatch ??
    ((reason: string) => {
      console.error(
        `[${opts.service}] refusing to run: ${reason}. Set the same COVE_FEE_ADDRESS on web, worker and Guardian, and deploy them from one commit.`,
      );
      process.exit(1);
    });
  if (!config.guardianEndpoint) {
    onMismatch(
      "COVE_GUARDIAN_ENDPOINT is not set, so the profile cannot be compared with the Guardian's",
    );
    return;
  }
  const check = async (): Promise<void> => {
    const h = await signer.health();
    if (h.reachable) {
      console.log(
        `[${opts.service}] Guardian runs the same mainnet profile (fee address included)`,
      );
      return;
    }
    if (
      h.reason?.startsWith("GUARDIAN_PROFILE_MISMATCH") ||
      h.reason === "GUARDIAN_KEY_MISMATCH"
    ) {
      onMismatch(h.reason);
      return;
    }
    console.warn(
      `[${opts.service}] cannot compare profiles with the Guardian yet (${h.reason ?? "unreachable"}); retrying`,
    );
    setTimeout(() => void check(), retryMs);
  };
  void check();
}
