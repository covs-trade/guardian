import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { createGuardianHttpServer } from "./http.js";
import { buildGuardianService } from "./service.js";
import { resolveGuardianBoot } from "./boot.js";
loadEnv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });
const CORE_CHAIN = {
  mainnet: "main",
  testnet: "test",
  signet: "signet",
  regtest: "regtest",
} as const;
async function main(): Promise<void> {
  const boot = resolveGuardianBoot(process.env);
  const built = buildGuardianService({
    profile: boot.profile,
    releaseId: process.env.RAILWAY_GIT_COMMIT_SHA ?? "local",
    databaseUrl: boot.databaseUrl,
    network: boot.network,
    signingArmed: boot.canaryActive,
    custodyBackend: boot.custodyBackend,
    coreRpc: boot.coreRpc,
    ordUrl: boot.ordUrl,
  });
  const chain = (await built.core.getBlockchainInfo()).chain;
  if (chain !== CORE_CHAIN[boot.network]) {
    throw new Error(
      `COVE_NETWORK is ${boot.network} but the node is on "${chain}"`,
    );
  }
  if (boot.custody !== "unconfigured") {
    const key = (await boot.custodyBackend.xOnlyPubkey()).toString("hex");
    if (key !== built.guardianXOnly.toLowerCase()) {
      throw new Error(
        "the Guardian key is not the profile's guardianXOnly; refusing to start",
      );
    }
  } else if (boot.mainnetGuard) {
    throw new Error("mainnet requires GUARDIAN_KEY_HEX");
  }
  const server = createGuardianHttpServer({
    transport: built.transport,
    authToken: boot.authToken,
  });
  server.listen(boot.port, () => {
    console.log(
      `Guardian service listening on :${boot.port} (network=${boot.network}, custody=${boot.custody}, profile=${boot.profile.source})`,
    );
  });
}
main().catch((e) => {
  console.error(
    "guardian service failed:",
    e instanceof Error ? e.message : String(e),
  );
  process.exit(1);
});
