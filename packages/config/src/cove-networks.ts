export const COVE_NETWORKS = [
  "regtest",
  "signet",
  "testnet",
  "mainnet",
] as const;
export type CoveNetworkName = (typeof COVE_NETWORKS)[number];
export interface CoveNetworkSettings {
  v3Enabled: boolean;
  workerPollMs: number;
  guardianPort: number;
  explorerUrl: string | null;
  esploraUrl: string | null;
  ordUrl: string | null;
  discoveryEnvelope: boolean;
}
export const COVE_NETWORK_SETTINGS: Record<
  CoveNetworkName,
  CoveNetworkSettings
> = {
  regtest: {
    v3Enabled: true,
    workerPollMs: 2000,
    guardianPort: 4391,
    explorerUrl: null,
    esploraUrl: null,
    ordUrl: null,
    discoveryEnvelope: false,
  },
  signet: {
    v3Enabled: true,
    workerPollMs: 5000,
    guardianPort: 4391,
    explorerUrl: "https://mempool.space/signet",
    esploraUrl: "https://mempool.space/signet/api",
    ordUrl: null,
    discoveryEnvelope: false,
  },
  testnet: {
    v3Enabled: true,
    workerPollMs: 5000,
    guardianPort: 4391,
    explorerUrl: "https://mempool.space/testnet",
    esploraUrl: "https://mempool.space/testnet/api",
    ordUrl: null,
    discoveryEnvelope: false,
  },
  mainnet: {
    v3Enabled: true,
    workerPollMs: 10000,
    guardianPort: 4391,
    explorerUrl: "https://mempool.space",
    esploraUrl: "https://mempool.space/api",
    ordUrl: "https://ordinals.com",
    discoveryEnvelope: false,
  },
};
export class CoveNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoveNetworkError";
  }
}
export function requireCoveNetwork(
  env: Record<string, string | undefined>,
): CoveNetworkName {
  const raw = env.COVE_NETWORK;
  if (!raw) {
    throw new CoveNetworkError(
      `COVE_NETWORK is required (one of ${COVE_NETWORKS.join(", ")}); there is no default`,
    );
  }
  if (!(COVE_NETWORKS as readonly string[]).includes(raw)) {
    throw new CoveNetworkError(
      `COVE_NETWORK "${raw}" is not one of ${COVE_NETWORKS.join(", ")}`,
    );
  }
  return raw as CoveNetworkName;
}
type Overridable =
  | "explorerUrl"
  | "esploraUrl"
  | "ordUrl"
  | "workerPollMs"
  | "discoveryEnvelope";
const OVERRIDE_ENV: Record<Overridable, string> = {
  explorerUrl: "NEXT_PUBLIC_EXPLORER_URL",
  esploraUrl: "COVE_ESPLORA_URL",
  ordUrl: "COVE_ORD_URL",
  workerPollMs: "COVE_WORKER_POLL_MS",
  discoveryEnvelope: "COVE_V3_DISCOVERY_ENVELOPE",
};
export function coveNetworkSettings(
  network: CoveNetworkName,
  env: Record<string, string | undefined> = {},
): CoveNetworkSettings {
  const base = COVE_NETWORK_SETTINGS[network];
  if (network === "mainnet") return { ...base };
  const s = { ...base };
  const get = (k: Overridable) => {
    const v = env[OVERRIDE_ENV[k]];
    return v === undefined || v === "" ? undefined : v;
  };
  const explorer = get("explorerUrl");
  if (explorer) s.explorerUrl = explorer.replace(/\/+$/, "");
  const esplora = get("esploraUrl");
  if (esplora) s.esploraUrl = esplora.replace(/\/+$/, "");
  const ord = get("ordUrl");
  if (ord) s.ordUrl = ord;
  const poll = get("workerPollMs");
  if (poll && Number.isFinite(Number(poll)) && Number(poll) > 0)
    s.workerPollMs = Number(poll);
  const discovery = get("discoveryEnvelope");
  if (discovery)
    s.discoveryEnvelope = ["true", "1", "yes", "on"].includes(
      discovery.toLowerCase(),
    );
  return s;
}
