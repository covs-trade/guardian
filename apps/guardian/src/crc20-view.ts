import * as bitcoin from "bitcoinjs-lib";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { requiredBackingV1 } from "@crclaunch/crc20-curve";
import type { Database } from "@crclaunch/db";
import type { CrcTrustedSnapshot } from "./crc20-validate.js";

const hex64 = /^[0-9a-f]{64}$/;
const positive = /^(0|[1-9][0-9]*)$/;

function stringField(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`CRC trusted view missing ${key}`);
  return value;
}

function atoms(row: Record<string, unknown>, key: string): bigint {
  const value = String(row[key] ?? "");
  if (!positive.test(value)) throw new Error(`CRC trusted view invalid ${key}`);
  return BigInt(value);
}

export function parseCrcSnapshotRow(
  row: Record<string, unknown>,
  network: CrcTrustedSnapshot["network"],
  deployTxid: string,
  configuredProtocolScriptHex: string,
): CrcTrustedSnapshot {
  if (!hex64.test(deployTxid)) throw new Error("invalid CRC deployment txid");
  const signedRawHex = stringField(row, "signed_raw_hex");
  if (!/^(?:[0-9a-f]{2})+$/.test(signedRawHex)) throw new Error("invalid CRC launch raw");
  const rawBytes = Buffer.from(signedRawHex, "hex");
  const rawHash = createHash("sha256").update(rawBytes).digest("hex");
  if (rawHash !== row.raw_sha256) throw new Error("CRC launch raw hash mismatch");
  const tx = bitcoin.Transaction.fromBuffer(rawBytes);
  if (tx.getId() !== deployTxid || tx.outs.length < 4)
    throw new Error("CRC launch raw does not bind deployment txid");
  const chunks = bitcoin.script.decompile(tx.outs[0]!.script);
  if (!chunks || chunks.length !== 2 || chunks[0] !== bitcoin.opcodes.OP_RETURN ||
    !Buffer.isBuffer(chunks[1]) || chunks[1].length > 256 || tx.outs[0]!.value !== 0)
    throw new Error("CRC launch marker is invalid");
  const marker = chunks[1];
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(marker.toString("utf8")) as Record<string, unknown>; }
  catch { throw new Error("CRC launch marker JSON is invalid"); }
  const ticker = stringField(row, "ticker");
  const protocolVersion = Number(row.protocol_version ?? 1);
  if (protocolVersion !== 1 && protocolVersion !== 2)
    throw new Error("CRC registered protocol version is invalid");
  if (payload.p !== "crc-20" || payload.op !== "deploy" || payload.tick !== ticker ||
    payload.type !== "bonding" || payload.max !== "2100000000000000" ||
    payload.cv !== `cove-curve-v${protocolVersion}` ||
    Object.keys(payload).sort().join(",") !== "cv,max,op,p,tick,type")
    throw new Error("CRC launch marker does not match registered asset version");
  const launchSaltHex = stringField(row, "launch_salt_hex");
  if (!hex64.test(launchSaltHex) || /^0+$/.test(launchSaltHex) || launchSaltHex !== row.intent_salt_hex)
    throw new Error("CRC launch salt mismatch");
  const vaultScriptHex = stringField(row, "vault_script_hex");
  const creatorScriptHex = stringField(row, "creator_script_hex");
  const protocolScriptHex = stringField(row, "protocol_script_hex");
  if (vaultScriptHex !== row.intent_vault_script_hex ||
    creatorScriptHex !== row.intent_creator_script_hex ||
    protocolScriptHex !== row.intent_protocol_script_hex ||
    protocolScriptHex !== configuredProtocolScriptHex ||
    tx.outs[1]!.script.toString("hex") !== vaultScriptHex ||
    tx.outs[2]!.script.toString("hex") !== creatorScriptHex || tx.outs[2]!.value !== 1000 ||
    tx.outs[3]!.script.toString("hex") !== protocolScriptHex || tx.outs[3]!.value !== 7000)
    throw new Error("CRC launch and canonical scripts mismatch");
  const anchorSats = atoms(row, "vault_anchor_sats");
  if (anchorSats <= 0n || BigInt(tx.outs[1]!.value) !== anchorSats)
    throw new Error("CRC launch vault anchor mismatch");
  if (row.availability !== "active") throw new Error("CRC asset vault is unavailable");
  const mintedAtoms = atoms(row, "minted_atoms");
  const vaultAtoms = atoms(row, "inventory_atoms");
  if (vaultAtoms > mintedAtoms || (mintedAtoms - vaultAtoms) % 100_000_000n !== 0n)
    throw new Error("CRC curve supply mismatch");
  const circulatingAtoms = mintedAtoms - vaultAtoms;
  const vaultSats = atoms(row, "btc_sats");
  if (vaultSats !== anchorSats + requiredBackingV1(circulatingAtoms / 100_000_000n))
    throw new Error("CRC vault reserve mismatch");
  const vaultTxid = stringField(row, "vault_txid");
  const vaultVout = Number(row.vault_vout);
  const cursorHeight = Number(atoms(row, "cursor_height"));
  const deployHeight = Number(atoms(row, "deploy_height"));
  const cursorBlockHash = stringField(row, "cursor_block_hash");
  const cursorStateRoot = stringField(row, "cursor_state_root");
  if (!hex64.test(vaultTxid) || !Number.isSafeInteger(vaultVout) || vaultVout < 0 ||
    !Number.isSafeInteger(cursorHeight) || cursorHeight < deployHeight ||
    !hex64.test(cursorBlockHash) || !hex64.test(cursorStateRoot) ||
    !hex64.test(stringField(row, "deploy_block_hash")))
    throw new Error("CRC canonical cursor or outpoint is invalid");
  return {
    network, deployTxid, ticker,
    deployMarkerBytes: marker,
    launchSalt: Buffer.from(launchSaltHex, "hex"),
    creatorScript: Buffer.from(creatorScriptHex, "hex"),
    protocolScript: Buffer.from(protocolScriptHex, "hex"),
    vaultOutpoint: { txid: vaultTxid, vout: vaultVout },
    vaultScript: Buffer.from(vaultScriptHex, "hex"),
    curve: {
      version: `cove-curve-v${protocolVersion}` as "cove-curve-v1" | "cove-curve-v2", mintedAtoms, vaultAtoms, circulatingAtoms,
      vaultAnchorSats: anchorSats, vaultSats, vaultOutpoint: `${vaultTxid}:${vaultVout}`,
    },
    sellerBalanceAtoms: atoms(row, "seller_balance_atoms"),
    protocolVersion,
    cursorHeight, cursorBlockHash, cursorStateRoot,
  };
}

export async function loadCrcTrustedSnapshot(params: {
  db: Database;
  network: CrcTrustedSnapshot["network"];
  deployTxid: string;
  payerScriptHex: string;
  configuredProtocolScriptHex: string;
}): Promise<CrcTrustedSnapshot> {
  const result = await params.db.execute(sql`
    select a.ticker, a.protocol_version, a.creator_script_hex, a.protocol_script_hex, a.launch_salt_hex,
      a.deploy_height::text, a.deploy_block_hash,
      i.signed_raw_hex, i.raw_sha256, i.launch_salt_hex as intent_salt_hex,
      i.vault_script_hex as intent_vault_script_hex,
      i.creator_script_hex as intent_creator_script_hex,
      i.protocol_script_hex as intent_protocol_script_hex,
      i.vault_anchor_sats::text,
      v.txid as vault_txid, v.vout as vault_vout, v.script_hex as vault_script_hex,
      v.btc_sats::text, v.minted_atoms::text, v.inventory_atoms::text, v.availability,
      coalesce(b.atoms, 0)::text as seller_balance_atoms,
      c.height::text as cursor_height, c.block_hash as cursor_block_hash, c.state_root as cursor_state_root
    from cove_crc_assets a
    join cove_crc_launch_intents i on i.network = a.network and i.txid = a.deploy_txid
    join cove_crc_vaults v on v.network = a.network and v.deploy_txid = a.deploy_txid
    join cove_crc_cursor c on c.network = a.network
    left join cove_crc_balances b on b.network = a.network and b.deploy_txid = a.deploy_txid and b.script_hex = ${params.payerScriptHex}
    where a.network = ${params.network} and a.deploy_txid = ${params.deployTxid}
    limit 1`);
  const row = result.rows[0];
  if (!row) throw new Error("CRC registered asset is unavailable");
  return parseCrcSnapshotRow(row, params.network, params.deployTxid, params.configuredProtocolScriptHex);
}
