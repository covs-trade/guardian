import { describe, expect, it } from "vitest";
import * as ecc from "tiny-secp256k1";
import { selectCustodyBackend } from "./custody.js";
import {
  EnvGuardianCustodyBackend,
  TestGuardianCustodyBackend,
  UnconfiguredGuardianCustodyBackend,
} from "@crclaunch/cove-guardian/v3";
const TEST_KEY = "42".repeat(32);
const REAL_KEY = "7a".repeat(32);
const REAL_XONLY = Buffer.from(
  ecc.pointFromScalar(Buffer.from(REAL_KEY, "hex"), true)!.subarray(1),
).toString("hex");
describe("Guardian custody backend selection (§C5)", () => {
  it("mainnet requires GUARDIAN_KEY_HEX and forbids the test key", () => {
    expect(() => selectCustodyBackend("mainnet", {})).toThrow(
      /GUARDIAN_KEY_HEX is required on mainnet/,
    );
    expect(() =>
      selectCustodyBackend("mainnet", { testKeyHex: TEST_KEY }),
    ).toThrow(/forbidden on mainnet/);
    expect(
      selectCustodyBackend("mainnet", { keyHex: REAL_KEY }),
    ).toBeInstanceOf(EnvGuardianCustodyBackend);
  });
  it("non-mainnet is unchanged: test key → test backend, none → unconfigured", () => {
    for (const network of ["regtest", "signet", "testnet"]) {
      expect(
        selectCustodyBackend(network, { testKeyHex: TEST_KEY }),
      ).toBeInstanceOf(TestGuardianCustodyBackend);
      expect(selectCustodyBackend(network, {})).toBeInstanceOf(
        UnconfiguredGuardianCustodyBackend,
      );
    }
  });
  it("refuses both keys at once", () => {
    expect(() =>
      selectCustodyBackend("regtest", {
        keyHex: REAL_KEY,
        testKeyHex: TEST_KEY,
      }),
    ).toThrow(/not both/);
  });
});
describe("EnvGuardianCustodyBackend", () => {
  it("signs with the key and exposes only the public key", async () => {
    const b = EnvGuardianCustodyBackend.fromHex(REAL_KEY);
    expect((await b.xOnlyPubkey()).toString("hex")).toBe(REAL_XONLY);
    const sighash = Buffer.alloc(32, 7);
    const sig = await b.signTaprootScriptPath({
      sighash,
      leafTapleafHash: Buffer.alloc(32),
    });
    expect(
      ecc.verifySchnorr(sighash, Buffer.from(REAL_XONLY, "hex"), sig),
    ).toBe(true);
    expect(JSON.stringify(b)).not.toContain(REAL_KEY);
    expect(Object.keys(b)).toEqual([]);
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(b)).sort()).toEqual(
      ["constructor", "signTaprootScriptPath", "toJSON", "xOnlyPubkey"],
    );
  });
  it("requires exactly 64 hex characters", () => {
    expect(() => EnvGuardianCustodyBackend.fromHex(undefined)).toThrow(
      /64 hex/,
    );
    expect(() => EnvGuardianCustodyBackend.fromHex("ab".repeat(31))).toThrow(
      /64 hex/,
    );
    expect(() => EnvGuardianCustodyBackend.fromHex("zz".repeat(32))).toThrow(
      /64 hex/,
    );
  });
  it("refuses every known repo test key", () => {
    for (const b of [
      "42",
      "43",
      "44",
      "46",
      "47",
      "48",
      "49",
      "51",
      "52",
      "53",
    ]) {
      expect(() => EnvGuardianCustodyBackend.fromHex(b.repeat(32))).toThrow(
        /public test keys/,
      );
      expect(() =>
        EnvGuardianCustodyBackend.fromHex(b.toUpperCase().repeat(32)),
      ).toThrow(/public test keys/);
    }
  });
  it("refuses an invalid scalar", () => {
    expect(() => EnvGuardianCustodyBackend.fromHex("00".repeat(32))).toThrow(
      /not a valid/,
    );
  });
});
