import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import * as core from "@crclaunch/crc20-protocol";
import { signGuardianPsbt } from "@crclaunch/crc20-adapters";
import { TestGuardianCustodyBackend } from "@crclaunch/cove-guardian/v3";
import { CrcGuardianSigningService as SharedService } from "@crclaunch/crc20-guardian";
import { CrcGuardianSigningService } from "./crc20-service.js";
test("standalone transport uses the same shared Guardian service", async () => {
  expect(CrcGuardianSigningService).toBe(SharedService);
  const service = new CrcGuardianSigningService({
    db: {} as never,
    core: {} as never,
    custodyBackend: {} as never,
    guardianXOnly: Buffer.alloc(32),
    recoveryProfile: {} as never,
    network: "regtest",
    protocolScript: Buffer.alloc(0),
    maxMinerFeeSats: 20000n,
  });
  expect(
    await service.sign({ network: "regtest", operation: "market-fill" }),
  ).toMatchObject({ ok: false, reason: "CRC_SIGN_REJECTED" });
});
test("published CRC runtime matches the authority manifest", () => {
  const root = new URL("../../../", import.meta.url);
  const manifest = JSON.parse(
    readFileSync(new URL("crc-core-source-manifest.json", root), "utf8"),
  );
  for (const [path, hash] of Object.entries(manifest.files))
    expect(
      createHash("sha256")
        .update(readFileSync(new URL(path, root)))
        .digest("hex"),
    ).toBe(hash);
});
test("standalone compiled core validates actual Xverse wallet proof and its own isolated custody signature", async () => {
  // This measured signing fixture uses a synthetic OP_TRUE recovery branch; it is not production custody.
  const request = core.decodeProtocolDto<{
    state: core.Asset;
    plan: core.Plan;
  }>(
    JSON.parse(
      readFileSync(
        new URL("./fixtures/core-mint-request.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  const response = JSON.parse(
    readFileSync(
      new URL("./fixtures/core-mint-response.json", import.meta.url),
      "utf8",
    ),
  );
  const psbt = bitcoin.Psbt.fromBase64(response.value.result.psbt);
  delete psbt.data.inputs[0]!.finalScriptWitness;
  const ledger = core.emptyLedger(request.state.config);
  ledger.assets[request.state.deployTxid] = request.state;
  const result = await signGuardianPsbt(
    psbt.toBase64(),
    ledger,
    new TestGuardianCustodyBackend(Buffer.alloc(32, 1)),
  );
  expect(
    core.validateFinalTransaction(
      result.transition.plan,
      result.transaction,
      ledger,
    ),
  ).toBe(core.parseRawTransaction(response.rawTransaction).txid);
  expect(result.transition.plan.minerFeeSats).toBe(1000n);
});
