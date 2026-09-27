import {
  EnvGuardianCustodyBackend,
  TestGuardianCustodyBackend,
  UnconfiguredGuardianCustodyBackend,
  type GuardianCustodyBackend,
} from "@crclaunch/cove-guardian/v3";
export function selectCustodyBackend(
  network: string,
  keys: {
    testKeyHex?: string;
    keyHex?: string;
  },
): GuardianCustodyBackend {
  if (keys.testKeyHex && keys.keyHex) {
    throw new Error("set GUARDIAN_KEY_HEX or GUARDIAN_TEST_KEY_HEX, not both");
  }
  if (network === "mainnet") {
    if (keys.testKeyHex) {
      throw new Error(
        "GUARDIAN_TEST_KEY_HEX is forbidden on mainnet — a production custody backend is required",
      );
    }
    if (!keys.keyHex)
      throw new Error("GUARDIAN_KEY_HEX is required on mainnet");
    return EnvGuardianCustodyBackend.fromHex(keys.keyHex);
  }
  if (keys.keyHex) return EnvGuardianCustodyBackend.fromHex(keys.keyHex);
  return keys.testKeyHex
    ? new TestGuardianCustodyBackend(Buffer.from(keys.testKeyHex, "hex"))
    : new UnconfiguredGuardianCustodyBackend();
}
