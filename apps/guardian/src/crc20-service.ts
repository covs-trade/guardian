import * as bitcoin from "bitcoinjs-lib";
import { sql } from "drizzle-orm";
import type { Database } from "@crclaunch/db";
import { buildCrc20AssetVault, crc20DeploymentTag, type VaultRecoveryProfile } from "@crclaunch/cove-vault";
import { signCrc20VaultInput } from "@crclaunch/cove-guardian/crc20";
import { extractWitnessSig, verifyVaultExecutionSignature, type GuardianCustodyBackend } from "@crclaunch/cove-guardian/v3";
import type { CoreRpcProvider } from "@crclaunch/bitcoin";
import { loadCrcTrustedSnapshot } from "./crc20-view.js";
import { validateCrc20Trade } from "./crc20-validate.js";
import type { CrcTradeOperation } from "./crc20-preflight.js";

export interface CrcSignRequest {
  requestId: string;
  network: "regtest" | "signet" | "testnet" | "mainnet";
  deploymentTxid: string;
  operation: CrcTradeOperation;
  psbtBase64: string;
}

export type CrcSignResponse =
  | { ok: true; signedPsbtBase64: string; signatureHex: string; unsignedTxDigest: string }
  | { ok: false; reason: string; detail: string };

export class CrcGuardianSigningService {
  constructor(private readonly options: {
    db: Database;
    core: CoreRpcProvider;
    custodyBackend: GuardianCustodyBackend;
    guardianXOnly: Buffer;
    recoveryProfile: VaultRecoveryProfile;
    network: CrcSignRequest["network"];
    protocolScript: Buffer;
    maxMinerFeeSats: bigint;
  }) {}

  async probe(): Promise<void> {
    await this.options.db.execute(sql`select network from cove_crc_signing_journal limit 1`);
    await this.options.db.execute(sql`select launch_salt_hex from cove_crc_assets limit 1`);
  }

  async sign(raw: unknown): Promise<CrcSignResponse> {
    try { return await this.signChecked(raw); }
    catch (error) {
      return { ok: false, reason: "CRC_SIGN_REJECTED", detail: error instanceof Error ? error.message : "CRC signing unavailable" };
    }
  }

  private async signChecked(raw: unknown): Promise<CrcSignResponse> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("invalid CRC signing request");
    const request = raw as Record<string, unknown>;
    if (typeof request.requestId !== "string" || request.requestId.length < 1 || request.requestId.length > 128 ||
      request.network !== this.options.network ||
      typeof request.deploymentTxid !== "string" || !/^[0-9a-f]{64}$/.test(request.deploymentTxid) ||
      !["mint-buy", "inventory-buy", "sell"].includes(String(request.operation)) ||
      typeof request.psbtBase64 !== "string" || request.psbtBase64.length > 750_000)
      throw new Error("CRC request operation, network, asset, or PSBT is invalid");
    const parsed = request as unknown as CrcSignRequest;
    const psbt = bitcoin.Psbt.fromBase64(parsed.psbtBase64);
    const payerScript = psbt.data.inputs[1]?.witnessUtxo?.script;
    if (!payerScript) throw new Error("CRC trade needs a wallet input");
    const guardianXOnly = await this.options.custodyBackend.xOnlyPubkey();
    if (!guardianXOnly.equals(this.options.guardianXOnly))
      throw new Error("CRC Guardian custody key does not match configured profile");
    const snapshot = await loadCrcTrustedSnapshot({
      db: this.options.db,
      network: this.options.network,
      deployTxid: parsed.deploymentTxid,
      payerScriptHex: payerScript.toString("hex"),
      configuredProtocolScriptHex: this.options.protocolScript.toString("hex"),
    });
    const assertCurrent = async () => {
      const cursorHash = await this.options.core.getBlockHash(snapshot.cursorHeight);
      if (cursorHash !== snapshot.cursorBlockHash)
        throw new Error("CRC indexer cursor diverged from Core");
      const result = await this.options.db.execute(sql`
        select v.txid, v.vout, v.script_hex, v.btc_sats::text, v.minted_atoms::text,
          v.inventory_atoms::text, v.availability, c.height::text as cursor_height,
          c.block_hash as cursor_hash, c.state_root,
          coalesce(b.atoms, 0)::text as seller_balance_atoms
        from cove_crc_vaults v join cove_crc_cursor c on c.network = v.network
        left join cove_crc_balances b on b.network = v.network and b.deploy_txid = v.deploy_txid
          and b.script_hex = ${payerScript.toString("hex")}
        where v.network = ${snapshot.network} and v.deploy_txid = ${snapshot.deployTxid}`);
      const row = result.rows[0];
      if (!row || row.txid !== snapshot.vaultOutpoint.txid || row.vout !== snapshot.vaultOutpoint.vout ||
        row.script_hex !== snapshot.vaultScript.toString("hex") ||
        String(row.btc_sats) !== snapshot.curve.vaultSats.toString() ||
        String(row.minted_atoms) !== snapshot.curve.mintedAtoms.toString() ||
        String(row.inventory_atoms) !== snapshot.curve.vaultAtoms.toString() ||
        row.availability !== "live" ||
        Number(row.cursor_height) !== snapshot.cursorHeight || row.cursor_hash !== snapshot.cursorBlockHash ||
        row.state_root !== snapshot.cursorStateRoot ||
        String(row.seller_balance_atoms) !== snapshot.sellerBalanceAtoms.toString())
        throw new Error("CRC canonical vault or cursor changed during signing");
    };
    await assertCurrent();
    const validated = await validateCrc20Trade({
      psbt, operation: parsed.operation, snapshot, guardianXOnly,
      recoveryProfile: this.options.recoveryProfile,
      expectedProtocolScript: this.options.protocolScript,
      maxMinerFeeSats: this.options.maxMinerFeeSats,
      prevouts: async (txid, vout) => {
        const output = await this.options.core.getTxout(txid, vout, true);
        return output ? {
          script: Buffer.from(output.scriptPubKeyHex, "hex"),
          valueSats: output.valueSats,
          confirmations: output.confirmations,
        } : null;
      },
      assertCurrent,
    });
    const digest = bitcoin.Transaction.fromBuffer(psbt.data.globalMap.unsignedTx.toBuffer()).getId();
    const vault = buildCrc20AssetVault({
      asset: { deploymentTag: crc20DeploymentTag(snapshot.deployMarkerBytes), launchSalt: snapshot.launchSalt },
      guardianXOnly, recoveryProfile: this.options.recoveryProfile,
      network: snapshot.network === "mainnet" ? bitcoin.networks.bitcoin :
        snapshot.network === "regtest" ? bitcoin.networks.regtest : bitcoin.networks.testnet,
    });
    const backingTxid = snapshot.vaultOutpoint.txid;
    const backingVout = snapshot.vaultOutpoint.vout;
    const inserted = await this.options.db.execute(sql`
      insert into cove_crc_signing_journal
        (network, backing_txid, backing_vout, unsigned_tx_digest, deploy_txid,
         operation, amount_atoms, gross_sats, protocol_fee_sats, miner_fee_sats,
         cursor_height, cursor_hash)
      values (${snapshot.network}, ${backingTxid}, ${backingVout}, ${digest}, ${snapshot.deployTxid},
        ${validated.operation}, ${validated.amountAtoms}, ${validated.grossSats},
        ${validated.protocolFeeSats}, ${validated.minerFeeSats}, ${snapshot.cursorHeight}, ${snapshot.cursorBlockHash})
      on conflict do nothing returning unsigned_tx_digest`);
    if (inserted.rows.length === 0) {
      const existing = await this.options.db.execute(sql`
        select signing_psbt_base64 from cove_crc_signing_journal
        where network = ${snapshot.network} and backing_txid = ${backingTxid}
          and backing_vout = ${backingVout} and unsigned_tx_digest = ${digest}`);
      const signed = existing.rows[0]?.signing_psbt_base64;
      if (typeof signed !== "string") throw new Error("CRC signing request is already in progress");
      const saved = bitcoin.Psbt.fromBase64(signed);
      if (bitcoin.Transaction.fromBuffer(saved.data.globalMap.unsignedTx.toBuffer()).getId() !== digest)
        throw new Error("CRC signed journal commitment mismatch");
      const witness = saved.data.inputs[0]?.finalScriptWitness;
      if (!witness) throw new Error("CRC saved signing result is missing vault witness");
      const signature = extractWitnessSig(witness);
      verifyVaultExecutionSignature(saved, 0, vault.executionLeaf, signature, guardianXOnly);
      return {
        ok: true, signedPsbtBase64: signed,
        signatureHex: signature.toString("hex"),
        unsignedTxDigest: digest,
      };
    }
    await assertCurrent();
    const signature = await signCrc20VaultInput(psbt, vault, this.options.custodyBackend);
    const signedPsbtBase64 = psbt.toBase64();
    const saved = await this.options.db.execute(sql`
      update cove_crc_signing_journal set signing_psbt_base64 = ${signedPsbtBase64}, signed_at = clock_timestamp()
      where network = ${snapshot.network} and backing_txid = ${backingTxid}
        and backing_vout = ${backingVout} and unsigned_tx_digest = ${digest}
        and signing_psbt_base64 is null returning unsigned_tx_digest`);
    if (saved.rows.length !== 1)
      throw new Error("CRC signature was produced but journal finalization failed");
    return { ok: true, signedPsbtBase64, signatureHex: signature.toString("hex"), unsignedTxDigest: digest };
  }
}
