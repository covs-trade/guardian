import * as bitcoin from "bitcoinjs-lib";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseCrcSnapshotRow } from "./crc20-view.js";

const network = "regtest" as const;
const ticker = "COVE";
const salt = "45".repeat(32);
const vaultScript = `5120${"11".repeat(32)}`;
const creatorScript = `0014${"22".repeat(20)}`;
const protocolScript = `0014${"33".repeat(20)}`;

function fixture(version: 1 | 2 = 1) {
  const marker = bitcoin.script.compile([bitcoin.opcodes.OP_RETURN!, Buffer.from(JSON.stringify({
    p: "crc-20", op: "deploy", tick: ticker, type: "bonding", max: "2100000000000000", cv: `cove-curve-v${version}`,
  }))]);
  const tx = new bitcoin.Transaction();
  tx.addInput(Buffer.alloc(32, 0x44), 0);
  tx.addOutput(marker, 0);
  tx.addOutput(Buffer.from(vaultScript, "hex"), 10_000);
  tx.addOutput(Buffer.from(creatorScript, "hex"), 1_000);
  tx.addOutput(Buffer.from(protocolScript, "hex"), 7_000);
  const signedRawHex = tx.toHex();
  const deployTxid = tx.getId();
  return { deployTxid, row: {
    ticker, protocol_version: version, creator_script_hex: creatorScript, protocol_script_hex: protocolScript,
    launch_salt_hex: salt, intent_salt_hex: salt,
    signed_raw_hex: signedRawHex,
    raw_sha256: createHash("sha256").update(Buffer.from(signedRawHex, "hex")).digest("hex"),
    intent_vault_script_hex: vaultScript,
    intent_creator_script_hex: creatorScript,
    intent_protocol_script_hex: protocolScript,
    vault_anchor_sats: "10000", deploy_height: "50", deploy_block_hash: "aa".repeat(32),
    vault_txid: "bb".repeat(32), vault_vout: 2, vault_script_hex: vaultScript,
    btc_sats: "10027", minted_atoms: "100000000000", inventory_atoms: "0",
    availability: "active", seller_balance_atoms: "100000000000",
    cursor_height: "51", cursor_block_hash: "cc".repeat(32), cursor_state_root: "dd".repeat(32),
  }};
}

describe("trusted CRC DB row parsing", () => {
  it("binds v2 deploy marker to the registered protocol version", () => {
    const f = fixture(2);
    expect(parseCrcSnapshotRow(f.row, network, f.deployTxid, protocolScript)).toMatchObject({
      protocolVersion: 2, curve: { version: "cove-curve-v2" },
    });
    expect(() => parseCrcSnapshotRow({ ...f.row, protocol_version: 1 }, network, f.deployTxid, protocolScript)).toThrow(/version/i);
  });
  it("binds confirmed deployment, launch intent, current vault and curve state", () => {
    const f = fixture();
    expect(parseCrcSnapshotRow(f.row, network, f.deployTxid, protocolScript)).toMatchObject({
      deployTxid: f.deployTxid,
      ticker,
      curve: { mintedAtoms: 100000000000n, vaultAtoms: 0n, circulatingAtoms: 100000000000n, vaultSats: 10027n },
    });
  });

  it("rejects altered intent raw, salt, vault identity and reserve", () => {
    const f = fixture();
    for (const change of [
      { raw_sha256: "00".repeat(32) },
      { intent_salt_hex: "46".repeat(32) },
      { intent_vault_script_hex: `5120${"ff".repeat(32)}` },
      { btc_sats: "10028" },
      { availability: "broken" },
    ]) {
      expect(() => parseCrcSnapshotRow({ ...f.row, ...change }, network, f.deployTxid, protocolScript)).toThrow();
    }
  });
});
