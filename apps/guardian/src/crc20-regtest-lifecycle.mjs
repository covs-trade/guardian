import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
import { CoreRpcProvider } from "@crclaunch/bitcoin";
import { quoteSell } from "@crclaunch/crc20-curve";
import { dustThreshold } from "@crclaunch/cove-economics";
import { TestGuardianCustodyBackend } from "@crclaunch/cove-guardian/v3";
import { resolveMainnetProfile } from "@crclaunch/cove-mainnet";
import { buildCrc20AssetVault, crc20DeploymentTag } from "@crclaunch/cove-vault";
import { createDb } from "@crclaunch/db";
import { CrcGuardianSigningService } from "./crc20-service.ts";

const { Buffer, fetch, AbortSignal, URL, process, console } = globalThis;
bitcoin.initEccLib(ecc);
const ECPair = ECPairFactory(ecc);
const network = "regtest";

class Rpc {
  constructor(url, user, password) { this.url = url; this.user = user; this.password = password; this.id = 0; }
  async call(method, params = [], wallet = false) {
    const response = await fetch(wallet ? `${this.url}/wallet/crc` : this.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Basic ${Buffer.from(`${this.user}:${this.password}`).toString("base64")}` },
      body: JSON.stringify({ jsonrpc: "1.0", id: ++this.id, method, params }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json();
    if (!response.ok || body.error || body.result === undefined) throw new Error(`Core ${method}: ${body.error?.message ?? response.status}`);
    return body.result;
  }
  async address() {
    const address = await this.call("getnewaddress", ["", "bech32m"], true);
    const info = await this.call("getaddressinfo", [address], true);
    return { address, scriptHex: info.scriptPubKey };
  }
  async mine(address) {
    const [hash] = await this.call("generatetoaddress", [1, address]);
    if (!hash) throw new Error("Core did not mine the transaction");
    return hash;
  }
}

function same(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
}

async function main() {
  const url = process.env.CRC_TEST_DATABASE_URL;
  const parsed = url ? new URL(url) : null;
  if (process.env.CRC_GUARDIAN_REGTEST_E2E !== "1" || parsed?.hostname !== "127.0.0.1" || parsed.port !== "5435" || parsed.pathname !== "/crc_test")
    throw new Error("requires CRC_GUARDIAN_REGTEST_E2E=1 and isolated localhost crc_test DB on port 5435");
  const appRepo = process.env.COVE_APP_REPO;
  if (!appRepo) throw new Error("set COVE_APP_REPO to the covedao checkout containing the CRC indexer");
  const { saveAuthorizedCrcLaunchIntent } = await import(pathToFileURL(join(appRepo, "packages/cove-indexer/src/crc20/intents.ts")).href);
  const { syncCrcTip } = await import(pathToFileURL(join(appRepo, "packages/cove-indexer/src/crc20/runner.ts")).href);
  const { hydrateCrcLedger } = await import(pathToFileURL(join(appRepo, "packages/cove-indexer/src/crc20/worker.ts")).href);
  const rpcUrl = process.env.CRC_REGTEST_RPC_URL ?? "http://127.0.0.1:18443";
  const rpcUser = process.env.CRC_REGTEST_RPC_USER ?? "crc";
  const rpcPassword = process.env.CRC_REGTEST_RPC_PASSWORD ?? "crc-regtest";
  const rpc = new Rpc(rpcUrl, rpcUser, rpcPassword);
  const core = new CoreRpcProvider({ url: rpcUrl, user: rpcUser, password: rpcPassword });
  const db = createDb(url);
  const existing = await db.execute(sql`select height from cove_crc_cursor where network = 'regtest'`);
  if (existing.rows.length) throw new Error("isolated regtest CRC projection is not empty");
  same((await core.getBlockchainInfo()).chain, "regtest", "Core chain");
  const wallet = ECPair.makeRandom();
  const walletScript = bitcoin.payments.p2wpkh({ pubkey: wallet.publicKey, network: bitcoin.networks.regtest }).output;
  const walletAddress = bitcoin.address.fromOutputScript(walletScript, bitcoin.networks.regtest);
  const miner = await rpc.address();
  const creator = await rpc.address();
  const profile = resolveMainnetProfile({ network }).profile;
  if (!profile.guardianXOnly || !profile.feeScript) throw new Error("regtest profile lacks Guardian key or fee script");
  const protocolScriptHex = profile.feeScript;
  const guardianPriv = Buffer.alloc(32, 0x42);
  const guardianXOnly = Buffer.from(ecc.pointFromScalar(guardianPriv, true)).subarray(1);
  same(guardianXOnly.toString("hex"), profile.guardianXOnly, "regtest profile Guardian key");
  const recoveryProfile = {
    profileVersion: "COVE_V3_VAULT_PROFILE_MAINNET1",
    recoveryCsvBlocks: profile.recovery.csvBlocks,
    recoveryThreshold: profile.recovery.threshold,
    recoveryPubkeys: profile.recovery.pubkeys.map((key) => Buffer.from(key, "hex")),
  };
  const custodyBackend = new TestGuardianCustodyBackend(guardianPriv);
  const ticker = `GS${randomBytes(3).toString("hex").toUpperCase()}`;
  const deployMarker = Buffer.from(JSON.stringify({ p: "crc-20", op: "deploy", tick: ticker, type: "bonding", max: "2100000000000000", cv: "cove-curve-v1" }));
  const launchSalt = randomBytes(32);
  const vault = buildCrc20AssetVault({ asset: { deploymentTag: crc20DeploymentTag(deployMarker), launchSalt }, guardianXOnly, recoveryProfile, network: bitcoin.networks.regtest });
  const fundedTxid = await rpc.call("sendtoaddress", [walletAddress, 0.002], true);
  await rpc.mine(miner.address);
  const funded = bitcoin.Transaction.fromHex(await rpc.call("getrawtransaction", [fundedTxid]));
  const fundedVout = funded.outs.findIndex((output) => output.value === 200_000 && output.script.equals(walletScript));
  if (fundedVout < 0) throw new Error("regtest wallet funding output missing");
  const deployPsbt = new bitcoin.Psbt({ network: bitcoin.networks.regtest });
  deployPsbt.setVersion(2);
  deployPsbt.addInput({ hash: fundedTxid, index: fundedVout, witnessUtxo: { script: walletScript, value: 200_000 }, sighashType: bitcoin.Transaction.SIGHASH_ALL });
  deployPsbt.addOutput({ script: bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, deployMarker]), value: 0 });
  deployPsbt.addOutput({ script: vault.scriptPubKey, value: 330 });
  deployPsbt.addOutput({ script: Buffer.from(creator.scriptHex, "hex"), value: 1_000 });
  deployPsbt.addOutput({ script: Buffer.from(protocolScriptHex, "hex"), value: 7_000 });
  deployPsbt.addOutput({ script: walletScript, value: 190_670 });
  deployPsbt.signInput(0, wallet);
  deployPsbt.finalizeAllInputs();
  const deploy = deployPsbt.extractTransaction();
  await saveAuthorizedCrcLaunchIntent(db, network, deploy.toHex(), {
    launchSaltHex: launchSalt.toString("hex"), vaultScriptHex: vault.scriptPubKey.toString("hex"),
    creatorScriptHex: creator.scriptHex, protocolScriptHex: protocolScriptHex, vaultAnchorSats: 330,
  });
  same(await rpc.call("sendrawtransaction", [deploy.toHex()]), deploy.getId(), "deploy broadcast");
  await rpc.mine(miner.address);
  const activationHeight = (await core.getBlockchainInfo()).blocks;
  let synced = await syncCrcTip({ db, provider: core, network, activationHeight, protocolScriptHex });
  const assetId = `${network}:${deploy.getId()}`;
  same(synced.snapshot.state.assets[assetId]?.status, "live", "confirmed deploy");
  const service = new CrcGuardianSigningService({ db, core, custodyBackend, guardianXOnly, recoveryProfile, network, protocolScript: Buffer.from(protocolScriptHex, "hex"), maxMinerFeeSats: 20_000n });
  await service.probe();
  const buyPsbt = new bitcoin.Psbt({ network: bitcoin.networks.regtest });
  buyPsbt.setVersion(2);
  buyPsbt.addInput({ hash: deploy.getId(), index: 1, witnessUtxo: { script: vault.scriptPubKey, value: 330 }, sighashType: bitcoin.Transaction.SIGHASH_ALL });
  buyPsbt.addInput({ hash: deploy.getId(), index: 4, witnessUtxo: { script: walletScript, value: 190_670 }, sighashType: bitcoin.Transaction.SIGHASH_ALL });
  buyPsbt.addOutput({ script: bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, Buffer.from(JSON.stringify({ p: "crc-20", op: "mint", tick: ticker, amt: "100000000000", id: deploy.getId() }))]), value: 0 });
  buyPsbt.addOutput({ script: walletScript, value: 330 });
  buyPsbt.addOutput({ script: vault.scriptPubKey, value: 357 });
  buyPsbt.addOutput({ script: Buffer.from(protocolScriptHex, "hex"), value: 5_013 });
  buyPsbt.addOutput({ script: Buffer.from(creator.scriptHex, "hex"), value: 546 });
  buyPsbt.addOutput({ script: walletScript, value: 183_754 });
  buyPsbt.signInput(1, wallet);
  const signed = await service.sign({ requestId: `regtest-${ticker}`, network, deploymentTxid: deploy.getId(), operation: "mint-buy", psbtBase64: buyPsbt.toBase64() });
  if (!signed.ok) throw new Error(`Guardian rejected mined buy: ${signed.detail}`);
  const finalPsbt = bitcoin.Psbt.fromBase64(signed.signedPsbtBase64, { network: bitcoin.networks.regtest });
  if (!finalPsbt.data.inputs[0]?.finalScriptWitness) throw new Error("Guardian did not finalize vault witness");
  finalPsbt.finalizeInput(1);
  const buy = finalPsbt.extractTransaction();
  same(await rpc.call("sendrawtransaction", [buy.toHex()]), buy.getId(), "Guardian buy broadcast");
  const buyBlock = await rpc.mine(miner.address);
  synced = await syncCrcTip({ db, provider: core, network, activationHeight, protocolScriptHex, snapshot: synced.snapshot });
  same(synced.snapshot.cursor?.hash, buyBlock, "indexed Guardian buy block");
  same(synced.snapshot.state.assets[assetId]?.curve.vaultOutpoint, `${buy.getId()}:2`, "indexed Guardian buy vault");
  same(synced.snapshot.state.assets[assetId]?.balances[walletScript.toString("hex")], "100000000000", "indexed Guardian buyer balance");
  const curve = synced.snapshot.state.assets[assetId].curve;
  const sellQuote = quoteSell(curve, 1_000n, dustThreshold(walletScript));
  const sellerFundingSats = buy.outs[5].value;
  const sellerChangeSats = Number(curve.vaultSats + BigInt(sellerFundingSats) -
    (curve.vaultSats - sellQuote.grossSats + sellQuote.sellerPayoutSats + sellQuote.protocolFeeSats) - 1_000n);
  if (sellerChangeSats < Number(dustThreshold(walletScript))) throw new Error("sell change is below dust");
  const sellPsbt = new bitcoin.Psbt({ network: bitcoin.networks.regtest });
  sellPsbt.setVersion(2);
  sellPsbt.addInput({ hash: buy.getId(), index: 2, witnessUtxo: { script: vault.scriptPubKey, value: Number(curve.vaultSats) }, sighashType: bitcoin.Transaction.SIGHASH_ALL });
  sellPsbt.addInput({ hash: buy.getId(), index: 5, witnessUtxo: { script: walletScript, value: sellerFundingSats }, sighashType: bitcoin.Transaction.SIGHASH_ALL });
  sellPsbt.addOutput({ script: bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, Buffer.from(JSON.stringify({ p: "crc-20", op: "transfer", tick: ticker, amt: "100000000000", id: deploy.getId() }))]), value: 0 });
  sellPsbt.addOutput({ script: vault.scriptPubKey, value: Number(curve.vaultSats - sellQuote.grossSats) });
  sellPsbt.addOutput({ script: walletScript, value: Number(sellQuote.sellerPayoutSats) });
  sellPsbt.addOutput({ script: Buffer.from(protocolScriptHex, "hex"), value: Number(sellQuote.protocolFeeSats) });
  sellPsbt.addOutput({ script: walletScript, value: sellerChangeSats });
  sellPsbt.signInput(1, wallet);
  const signedSell = await service.sign({ requestId: `regtest-${ticker}-sell`, network, deploymentTxid: deploy.getId(), operation: "sell", psbtBase64: sellPsbt.toBase64() });
  if (!signedSell.ok) throw new Error(`Guardian rejected mined sell: ${signedSell.detail}`);
  const finalSellPsbt = bitcoin.Psbt.fromBase64(signedSell.signedPsbtBase64, { network: bitcoin.networks.regtest });
  if (!finalSellPsbt.data.inputs[0]?.finalScriptWitness) throw new Error("Guardian did not finalize sell vault witness");
  finalSellPsbt.finalizeInput(1);
  const sell = finalSellPsbt.extractTransaction();
  same(await rpc.call("sendrawtransaction", [sell.toHex()]), sell.getId(), "Guardian sell broadcast");
  const sellBlock = await rpc.mine(miner.address);
  synced = await syncCrcTip({ db, provider: core, network, activationHeight, protocolScriptHex, snapshot: synced.snapshot });
  same(synced.snapshot.cursor?.hash, sellBlock, "indexed Guardian sell block");
  same(synced.snapshot.state.assets[assetId]?.curve.vaultOutpoint, `${sell.getId()}:1`, "indexed Guardian sell vault");
  same(synced.snapshot.state.assets[assetId]?.curve.vaultSats, curve.vaultSats - sellQuote.grossSats, "indexed Guardian sell reserve");
  same(synced.snapshot.state.assets[assetId]?.curve.circulatingAtoms, 0n, "indexed Guardian circulating supply");
  same(synced.snapshot.state.assets[assetId]?.balances[walletScript.toString("hex")], "0", "indexed Guardian seller balance");
  same(sell.outs[2]?.value, Number(sellQuote.sellerPayoutSats), "mined seller payout");
  same(sell.outs[2]?.script.toString("hex"), walletScript.toString("hex"), "mined seller payout script");
  const persisted = await hydrateCrcLedger(db, network);
  same(persisted.state.assets[assetId]?.curve.vaultSats, curve.vaultSats - sellQuote.grossSats, "persisted sell reserve");
  same(persisted.state.assets[assetId]?.balances[walletScript.toString("hex")] ?? "0", "0", "persisted seller token balance");
  const chainVault = await rpc.call("gettxout", [sell.getId(), 1]);
  const chainPayout = await rpc.call("gettxout", [sell.getId(), 2]);
  same(chainVault ? Math.round(chainVault.value * 100_000_000) : null, Number(curve.vaultSats - sellQuote.grossSats), "Core sell vault output");
  same(chainPayout ? Math.round(chainPayout.value * 100_000_000) : null, Number(sellQuote.sellerPayoutSats), "Core seller payout output");
  const journal = await db.execute(sql`select count(*)::int as count from cove_crc_signing_journal where network = 'regtest' and deploy_txid = ${deploy.getId()} and signed_at is not null`);
  same(journal.rows[0]?.count, 2, "durable Guardian buy and sell signature journal");
  console.log(JSON.stringify({ ok: true, ticker, deployTxid: deploy.getId(), buyTxid: buy.getId(), sellTxid: sell.getId(), cursor: synced.snapshot.cursor?.height, guardianJournalRows: 2 }));
  await db.execute(sql`delete from cove_crc_signing_journal where network = 'regtest'`);
  await db.execute(sql`delete from cove_crc_events where network = 'regtest'`);
  await db.execute(sql`delete from cove_crc_undo where network = 'regtest'`);
  await db.execute(sql`delete from cove_crc_blocks where network = 'regtest'`);
  await db.execute(sql`delete from cove_crc_balances where network = 'regtest'`);
  await db.execute(sql`delete from cove_crc_vaults where network = 'regtest'`);
  await db.execute(sql`delete from cove_crc_assets where network = 'regtest'`);
  await db.execute(sql`delete from cove_crc_cursor where network = 'regtest'`);
  await db.execute(sql`delete from cove_crc_launch_intents where network = 'regtest'`);
}

main().then(() => process.exit(0), (error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
