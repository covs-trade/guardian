import { dirname, resolve as resolvePath } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { parse as parseToml } from "smol-toml";
import * as bitcoin from "bitcoinjs-lib";
import {
  parseMainnetProfile,
  validateMainnetProfile,
  hashMainnetProfile,
  type MainnetProfile,
  type MainnetProfileValidationResult,
} from "./profile.js";
function bundledProfilesPath(): string {
  let directory = process.cwd();
  for (let depth = 0; depth < 6; depth++) {
    const path = resolvePath(directory, "packages/cove-mainnet/profiles.toml");
    if (existsSync(path)) return path;
    directory = dirname(directory);
  }
  throw new Error("packages/cove-mainnet/profiles.toml is missing");
}

export const MAINNET_PROFILES_PATH = bundledProfilesPath();

function profileFromToml(text: string, network: string): MainnetProfile {
  const document = parseToml(text) as Record<string, unknown>;
  const protocol = document.protocol as Record<string, unknown> | undefined;
  const networks = document.networks as Record<string, unknown> | undefined;
  const selected = networks?.[network] as Record<string, unknown> | undefined;
  if (!protocol || !selected) {
    throw new Error(`profiles.toml has no ${network} profile`);
  }
  return parseMainnetProfile({ ...protocol, ...selected });
}

function bundledProfile(network: string): MainnetProfile {
  return profileFromToml(readFileSync(MAINNET_PROFILES_PATH, "utf8"), network);
}

export interface CommittedMainnetProfile {
  profile: MainnetProfile;
  validation: MainnetProfileValidationResult;
  profileHash: string;
}
export const FEE_ADDRESS_ENV = "COVE_FEE_ADDRESS";
export function feeScriptFromAddress(
  address: string,
  network: bitcoin.networks.Network,
): string {
  try {
    return Buffer.from(
      bitcoin.address.toOutputScript(address.trim(), network),
    ).toString("hex");
  } catch {
    throw new Error(
      `${FEE_ADDRESS_ENV} "${address}" is not a valid address for this network`,
    );
  }
}
export function committedMainnetProfile(
  opts: {
    feeAddress?: string;
  } = {},
): CommittedMainnetProfile {
  const profile = bundledProfile("mainnet");
  if (opts.feeAddress)
    profile.feeScript = feeScriptFromAddress(
      opts.feeAddress,
      bitcoin.networks.bitcoin,
    );
  return {
    profile,
    validation: validateMainnetProfile(profile),
    profileHash: hashMainnetProfile(profile),
  };
}
export const TEST_ONLY_PROFILE_ENV = "COVE_TEST_ONLY_PROFILE_PATH";
export interface ResolvedMainnetProfile extends CommittedMainnetProfile {
  source: "committed" | "test-only";
}
export function resolveMainnetProfile(params: {
  network: string;
  testOnlyPath?: string;
  baseDir?: string;
  feeAddress?: string;
}): ResolvedMainnetProfile {
  if (params.testOnlyPath && params.network === "mainnet") {
    throw new Error(`${TEST_ONLY_PROFILE_ENV} is refused on mainnet: mainnet runs only the committed profile`);
  }
  const selectedNetwork = params.network === "tooling"
    ? params.testOnlyPath ? "regtest" : "mainnet"
    : params.network;
  const profile = params.testOnlyPath
    ? profileFromToml(
        readFileSync(
          params.baseDir
            ? resolvePath(params.baseDir, params.testOnlyPath)
            : params.testOnlyPath,
          "utf8",
        ),
        selectedNetwork,
      )
    : bundledProfile(selectedNetwork);
  if (selectedNetwork === "mainnet" && params.feeAddress) {
    profile.feeScript = feeScriptFromAddress(params.feeAddress, bitcoin.networks.bitcoin);
  }
  const testOnly = selectedNetwork !== "mainnet";
  return {
    profile,
    validation: validateMainnetProfile(profile, { allowTestKeys: testOnly }),
    profileHash: hashMainnetProfile(profile),
    source: testOnly ? "test-only" : "committed",
  };
}
