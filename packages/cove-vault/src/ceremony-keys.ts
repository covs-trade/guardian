import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";
bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);
const ECPair = ECPairFactory(ecc);
function xOnlyHex(priv: Buffer): string {
  return Buffer.from(
    ECPair.fromPrivateKey(priv).publicKey.subarray(1),
  ).toString("hex");
}
function main(): void {
  const args = process.argv.slice(2);
  const recoveryFlag = args.indexOf("--recovery-keys");
  const recoveryCount = recoveryFlag >= 0 ? Number(args[recoveryFlag + 1]) : 3;
  if (recoveryCount !== 1 && recoveryCount !== 3) {
    throw new Error("--recovery-keys must be 1 or 3");
  }
  const keyRoles = [
    "guardian",
    ...Array.from({ length: recoveryCount }, (_, i) => `recovery-${i + 1}`),
  ];
  const outFlag = args.indexOf("--out");
  const outDir = resolve(
    outFlag >= 0 && args[outFlag + 1] ? args[outFlag + 1]! : ".ceremony/keys",
  );
  mkdirSync(outDir, { recursive: true });
  for (const role of keyRoles) {
    const file = resolve(outDir, `${role}.key`);
    if (existsSync(file))
      throw new Error(`refusing to overwrite existing key file: ${file}`);
  }
  const privateKeys = new Map<string, string>();
  for (const role of keyRoles) {
    const file = resolve(outDir, `${role}.key`);
    const priv = randomBytes(32);
    const privHex = priv.toString("hex");
    writeFileSync(file, privHex + "\n", { mode: 0o600 });
    privateKeys.set(role, privHex);
  }
  console.log("Key-generation ceremony complete.");
  console.log("");
  console.log("X-ONLY BIP340 PUBLIC KEYS (copy these into the profile):");
  for (const role of keyRoles) {
    console.log(
      `  ${role.padEnd(12)} ${xOnlyHex(Buffer.from(privateKeys.get(role)!, "hex"))}`,
    );
  }
  console.log("");
  console.log(`Private keys written to: ${outDir}/`);
  console.log("Storage checklist:");
  console.log(
    "  [ ] guardian.key    → Guardian service only (keep an offline backup)",
  );
  for (let i = 1; i <= recoveryCount; i++) {
    console.log(
      `  [ ] recovery-${i}.key  → offline recovery storage, separate from Guardian`,
    );
  }
  console.log(
    "  [ ] Confirm each file is mode 0600 and gitignored (never committed).",
  );
  console.log(
    "  [ ] Verify the x-only pubkeys above before funding or deploying anything.",
  );
}
main();
