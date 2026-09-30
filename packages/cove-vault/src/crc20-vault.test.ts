import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { describe, expect, it } from "vitest";
import { buildCrc20BackingVault, crc20DeploymentTag, randomCrc20LaunchSalt } from "./crc20-vault.js";
import { dev1RecoveryProfile } from "./vaultProfile.js";

const key = (byte: number) => Buffer.from(ecc.pointFromScalar(Buffer.alloc(32, byte), true)!).subarray(1);
const guardianXOnly = key(0x41);
const ownerXOnly = key(0x42);
const recoveryProfile = dev1RecoveryProfile(ownerXOnly);
const state = {
  deploymentTag: Buffer.alloc(32, 0x43),
  launchSalt: Buffer.alloc(32, 0x45),
  mintedAtoms: 100_000_000_000n,
  vaultAtoms: 0n,
  backingSats: 27n,
  anchorSats: 10_000n,
};

describe("Cove CRC-20 vault commitment", () => {
  it("derives an initial asset tag from the deploy marker without a circular txid dependency", () => {
    const marker = Buffer.from('{"p":"crc-20","op":"deploy","tick":"COVE"}');
    expect(crc20DeploymentTag(marker).equals(crc20DeploymentTag(marker))).toBe(true);
    expect(crc20DeploymentTag(marker).equals(crc20DeploymentTag(Buffer.from('{"p":"crc-20","op":"deploy","tick":"OTHER"}')))).toBe(false);
    expect(crc20DeploymentTag(marker)).toHaveLength(32);
  });
  it("derives a stable address and a Guardian execution leaf from canonical state", () => {
    const a = buildCrc20BackingVault({ state, guardianXOnly, recoveryProfile, network: bitcoin.networks.regtest });
    const b = buildCrc20BackingVault({ state, guardianXOnly, recoveryProfile, network: bitcoin.networks.regtest });
    expect(a.scriptPubKey.equals(b.scriptPubKey)).toBe(true);
    expect(a.executionLeaf.script.includes(guardianXOnly)).toBe(true);
    expect(a.executionControlBlock.length).toBe(65);
    expect(a.address.startsWith("bcrt1p")).toBe(true);
  });

  it("changes the vault script when asset identity or supply/backing changes", () => {
    const base = buildCrc20BackingVault({ state, guardianXOnly, recoveryProfile });
    for (const changed of [
      { ...state, deploymentTag: Buffer.alloc(32, 0x44) },
      { ...state, launchSalt: Buffer.alloc(32, 0x46) },
      { ...state, mintedAtoms: 200_000_000_000n },
      { ...state, backingSats: 28n },
    ]) {
      expect(buildCrc20BackingVault({ state: changed, guardianXOnly, recoveryProfile }).scriptPubKey.equals(base.scriptPubKey)).toBe(false);
    }
  });

  it("separates two launches with identical deploy marker bytes", () => {
    const marker = Buffer.from('{"p":"crc-20","op":"deploy","tick":"COVE"}');
    const deploymentTag = crc20DeploymentTag(marker);
    const a = buildCrc20BackingVault({ state: { ...state, deploymentTag, launchSalt: Buffer.alloc(32, 0x45) }, guardianXOnly, recoveryProfile });
    const b = buildCrc20BackingVault({ state: { ...state, deploymentTag, launchSalt: Buffer.alloc(32, 0x46) }, guardianXOnly, recoveryProfile });
    expect(a.scriptPubKey.equals(b.scriptPubKey)).toBe(false);
    expect(randomCrc20LaunchSalt()).toHaveLength(32);
    expect(randomCrc20LaunchSalt().equals(randomCrc20LaunchSalt())).toBe(false);
  });

  it("requires distinct valid keys and rejects an inconsistent reserve", () => {
    expect(() => buildCrc20BackingVault({ state, guardianXOnly, recoveryProfile: dev1RecoveryProfile(guardianXOnly) })).toThrow(/distinct/i);
    expect(() => buildCrc20BackingVault({ state: { ...state, backingSats: -1n }, guardianXOnly, recoveryProfile })).toThrow(/backing/i);
    expect(() => buildCrc20BackingVault({ state: { ...state, vaultAtoms: 200_000_000_000n }, guardianXOnly, recoveryProfile })).toThrow(/supply/i);
    expect(() => buildCrc20BackingVault({ state: { ...state, launchSalt: Buffer.alloc(32) }, guardianXOnly, recoveryProfile })).toThrow(/salt/i);
  });
});
