import { resolveMainnetProfile } from "@crclaunch/cove-mainnet";
import { CoreRpcProvider } from "@crclaunch/bitcoin";
import { createDb } from "@crclaunch/db";
import { computeHealth } from "@crclaunch/cove-indexer/v3";
import {
  checkCoreAgreement,
  computeMainnetReadiness,
  deriveReadinessState,
  type MainnetReadiness,
  type ReadinessState,
} from "./readiness.js";
import {
  committedHash,
  evaluateIndexerProbe,
  probeWorkerLock,
} from "./readiness-probes.js";
export interface RuntimeReadinessEnv {
  COVE_TEST_ONLY_PROFILE_PATH?: string;
  COVE_FEE_ADDRESS?: string;
  COVE_V3_MAINNET_PROFILE_HASH?: string;
  COVE_V3_MAINNET_STATE_ROOT?: string;
  COVE_V3_MAINNET_RELEASE_MANIFEST_HASH?: string;
  COVE_BITCOIN_RPC_URL?: string;
  COVE_BITCOIN_RPC_URL_SECONDARY?: string;
  COVE_BITCOIN_RPC_USER?: string;
  COVE_BITCOIN_RPC_PASSWORD?: string;
  COVE_GUARDIAN_ENDPOINT?: string;
  COVE_GUARDIAN_AUTH_TOKEN?: string;
  COVE_V3_CANARY_ACTIVE?: string;
  COVE_DATABASE_URL?: string;
}
export interface RuntimeReadinessResult {
  state: ReadinessState;
  readiness: MainnetReadiness;
  profileHash: string;
  expectedProfileHash: string | null;
  profileSource: "committed" | "test-only";
  stateRoot: string;
  coreAgreementDetail: string | null;
}
async function guardianHealthHttp(endpoint: string, token: string) {
  const res = await fetch(`${endpoint}/health`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`guardian /health HTTP ${res.status}`);
  return (await res.json()) as {
    reachable: boolean;
    profileHash: string;
    guardianXOnly: string;
    auditHealthy: boolean;
    signingJournalHealthy: boolean;
    custodyBackendReady: boolean;
    signingEnabled: boolean;
  };
}
export async function runRuntimeReadiness(
  env: RuntimeReadinessEnv,
): Promise<RuntimeReadinessResult> {
  const { profile, profileHash, source } = resolveMainnetProfile({
    network: "tooling",
    testOnlyPath: env.COVE_TEST_ONLY_PROFILE_PATH,
    baseDir: process.env.INIT_CWD ?? process.cwd(),
    feeAddress: env.COVE_FEE_ADDRESS || undefined,
  });
  const canaryActive = ["true", "1", "yes", "on"].includes(
    (env.COVE_V3_CANARY_ACTIVE ?? "").toLowerCase(),
  );
  const expectedProfileHash = committedHash(env.COVE_V3_MAINNET_PROFILE_HASH);
  const expectedStateRoot = committedHash(env.COVE_V3_MAINNET_STATE_ROOT);
  const releaseManifestOk =
    committedHash(env.COVE_V3_MAINNET_RELEASE_MANIFEST_HASH) !== null;
  const rpcUser = env.COVE_BITCOIN_RPC_USER ?? "user";
  const rpcPassword = env.COVE_BITCOIN_RPC_PASSWORD ?? "pass";
  const primary = new CoreRpcProvider({
    url: env.COVE_BITCOIN_RPC_URL ?? "http://127.0.0.1:18443",
    user: rpcUser,
    password: rpcPassword,
  });
  let primaryCoreHealthy = false;
  let secondaryCoreHealthy = false;
  let coreAgreement = false;
  let coreAgreementDetail: string | null = "no secondary Core configured";
  try {
    await primary.getBlockchainInfo();
    primaryCoreHealthy = true;
  } catch {
    primaryCoreHealthy = false;
  }
  const secondaryUrl = env.COVE_BITCOIN_RPC_URL_SECONDARY;
  if (secondaryUrl) {
    const secondary = new CoreRpcProvider({
      url: secondaryUrl,
      user: rpcUser,
      password: rpcPassword,
    });
    try {
      await secondary.getBlockchainInfo();
      secondaryCoreHealthy = true;
      const agreement = await checkCoreAgreement(primary, secondary);
      coreAgreement = agreement.agreed;
      coreAgreementDetail = agreement.detail;
    } catch {
      secondaryCoreHealthy = false;
      coreAgreementDetail = "secondary unreachable";
    }
  }
  let indexerHealthy = false;
  let stateRootVerified = false;
  let stateRoot = "";
  let workerHealthy = false;
  if (env.COVE_DATABASE_URL) {
    try {
      const db = createDb(env.COVE_DATABASE_URL);
      const health = await computeHealth({
        db,
        network: "mainnet",
        provider: primary,
      });
      ({ indexerHealthy, stateRootVerified, stateRoot } = evaluateIndexerProbe(
        health,
        expectedStateRoot,
      ));
      workerHealthy = await probeWorkerLock(db, "mainnet");
    } catch {
      workerHealthy = false;
    }
  }
  let guardianHealthy = false;
  let guardianProfileHash: string | null = null;
  let guardianXOnly: string | null = null;
  let custodyBackendReady = false;
  let auditHealthy = false;
  let signingJournalHealthy = false;
  if (env.COVE_GUARDIAN_ENDPOINT) {
    try {
      const h = await guardianHealthHttp(
        env.COVE_GUARDIAN_ENDPOINT,
        env.COVE_GUARDIAN_AUTH_TOKEN ?? "",
      );
      guardianHealthy = h.reachable;
      guardianProfileHash = h.profileHash;
      guardianXOnly = h.guardianXOnly;
      custodyBackendReady = h.custodyBackendReady;
      auditHealthy = h.auditHealthy;
      signingJournalHealthy = h.signingJournalHealthy;
    } catch {
      guardianHealthy = false;
    }
  }
  const readiness = computeMainnetReadiness({
    allowTestKeys: source === "test-only",
    profile,
    profileHash,
    expectedProfileHash: expectedProfileHash ?? "",
    releaseManifestOk,
    primaryCoreHealthy,
    secondaryCoreHealthy,
    coreAgreement,
    indexerHealthy,
    stateRootVerified,
    workerHealthy,
    guardianHealthy,
    guardianProfileHash,
    guardianXOnly,
    custodyBackendReady,
    auditHealthy,
    signingJournalHealthy,
    canaryActive,
  });
  return {
    state: deriveReadinessState(readiness),
    readiness,
    profileHash,
    expectedProfileHash,
    profileSource: source,
    stateRoot,
    coreAgreementDetail,
  };
}
