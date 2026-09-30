import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
import { CoreRpcProvider } from "@crclaunch/bitcoin";
import { quoteBuy, quoteSell } from "@crclaunch/crc20-curve";
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
  const deployMarker = Buffer.from(JSON.stringify({ p: "crc-20", op: "deploy", tick: ticker, type: "bonding", max: "2100000000000000", cv: "cove-curve-v2" }));
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
  same(synced.snapshot.state.assets[assetId]?.protocolVersion, 2, "confirmed v2 protocol");
  const service = new CrcGuardianSigningService({ db, core, custodyBackend, guardianXOnly, recoveryProfile, network, protocolScript: Buffer.from(protocolScriptHex, "hex"), maxMinerFeeSats: 20_000n });
  await service.probe();
  const buyPsbt = new bitcoin.Psbt({ network: bitcoin.networks.regtest });
  buyPsbt.setVersion(2);
  buyPsbt.addInput({ hash: deploy.getId(), index: 1, witnessUtxo: { script: vault.scriptPubKey, value: 330 }, sighashType: bitcoin.Transaction.SIGHASH_ALL });
  buyPsbt.addInput({ hash: deploy.getId(), index: 4, witnessUtxo: { script: walletScript, value: 190_670 }, sighashType: bitcoin.Transaction.SIGHASH_ALL });
  buyPsbt.addOutput({ script: bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, Buffer.from(JSON.stringify({ p: "crc-20", op: "mint", tick: ticker, amt: "100000000000", id: deploy.getId(), v: 2 }))]), value: 0 });
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
  same(synced.snapshot.state.assets[assetId]?.tokenUtxos?.[`${buy.getId()}:1`]?.atoms, "100000000000", "indexed v2 buyer token outpoint");
  const buyCoin = await db.execute(sql`select atoms::text, script_hex from cove_crc_token_utxos where network = 'regtest' and deploy_txid = ${deploy.getId()} and txid = ${buy.getId()} and vout = 1`);
  same(buyCoin.rows[0]?.atoms, "100000000000", "persisted v2 buyer token outpoint");
  same(buyCoin.rows[0]?.script_hex, walletScript.toString("hex"), "persisted v2 buyer owner");
  const curve = synced.snapshot.state.assets[assetId].curve;
  const sellQuote = quoteSell(curve, 1_000n, dustThreshold(walletScript));
  const sellerFundingSats = buy.outs[5].value;
  const sellerChangeSats = Number(curve.vaultSats + BigInt(buy.outs[1].value) + BigInt(sellerFundingSats) -
    (curve.vaultSats - sellQuote.grossSats + sellQuote.sellerPayoutSats + BigInt(buy.outs[1].value) + sellQuote.protocolFeeSats) - 1_000n);
  if (sellerChangeSats < Number(dustThreshold(walletScript))) throw new Error("sell change is below dust");
  const sellPsbt = new bitcoin.Psbt({ network: bitcoin.networks.regtest });
  sellPsbt.setVersion(2);
  sellPsbt.addInput({ hash: buy.getId(), index: 2, witnessUtxo: { script: vault.scriptPubKey, value: Number(curve.vaultSats) }, sighashType: bitcoin.Transaction.SIGHASH_ALL });
  sellPsbt.addInput({ hash: buy.getId(), index: 1, witnessUtxo: { script: walletScript, value: buy.outs[1].value }, sighashType: bitcoin.Transaction.SIGHASH_ALL });
  sellPsbt.addInput({ hash: buy.getId(), index: 5, witnessUtxo: { script: walletScript, value: sellerFundingSats }, sighashType: bitcoin.Transaction.SIGHASH_ALL });
  sellPsbt.addOutput({ script: bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, Buffer.from(JSON.stringify({ p: "crc-20", op: "transfer", tick: ticker, amt: "100000000000", id: deploy.getId(), v: 2 }))]), value: 0 });
  sellPsbt.addOutput({ script: vault.scriptPubKey, value: Number(curve.vaultSats - sellQuote.grossSats) });
  sellPsbt.addOutput({ script: walletScript, value: Number(sellQuote.sellerPayoutSats + BigInt(buy.outs[1].value)) });
  sellPsbt.addOutput({ script: Buffer.from(protocolScriptHex, "hex"), value: Number(sellQuote.protocolFeeSats) });
  sellPsbt.addOutput({ script: walletScript, value: sellerChangeSats });
  sellPsbt.signInput(1, wallet);
  sellPsbt.signInput(2, wallet);
  const substituted = new bitcoin.Psbt({ network: bitcoin.networks.regtest });
  substituted.setVersion(2);
  substituted.addInput({ hash: buy.getId(), index: 2, witnessUtxo: { script: vault.scriptPubKey, value: Number(curve.vaultSats) }, sighashType: bitcoin.Transaction.SIGHASH_ALL });
  substituted.addInput({ hash: buy.getId(), index: 5, witnessUtxo: { script: walletScript, value: sellerFundingSats }, sighashType: bitcoin.Transaction.SIGHASH_ALL });
  for (const output of sellPsbt.txOutputs) substituted.addOutput(output);
  substituted.signInput(1, wallet);
  const refusedSubstitution = await service.sign({ requestId: `regtest-${ticker}-substitution`, network, deploymentTxid: deploy.getId(), operation: "sell", psbtBase64: substituted.toBase64() });
  if (refusedSubstitution.ok || !/token-bearing seller input/.test(refusedSubstitution.detail))
    throw new Error(`Guardian accepted same-script BTC substitution: ${JSON.stringify(refusedSubstitution)}`);
  const alteredBacking = new bitcoin.Psbt({ network: bitcoin.networks.regtest });
  alteredBacking.setVersion(2);
  alteredBacking.addInput({ hash: buy.getId(), index: 2, witnessUtxo: { script: vault.scriptPubKey, value: Number(curve.vaultSats) }, sighashType: bitcoin.Transaction.SIGHASH_ALL });
  alteredBacking.addInput({ hash: buy.getId(), index: 1, witnessUtxo: { script: walletScript, value: buy.outs[1].value }, sighashType: bitcoin.Transaction.SIGHASH_ALL });
  alteredBacking.addInput({ hash: buy.getId(), index: 5, witnessUtxo: { script: walletScript, value: sellerFundingSats }, sighashType: bitcoin.Transaction.SIGHASH_ALL });
  for (const [index, output] of sellPsbt.txOutputs.entries()) alteredBacking.addOutput({
    script: output.script,
    value: output.value + (index === 1 ? 1 : index === 4 ? -1 : 0),
  });
  alteredBacking.signInput(1, wallet);
  alteredBacking.signInput(2, wallet);
  const refusedBacking = await service.sign({ requestId: `regtest-${ticker}-backing`, network, deploymentTxid: deploy.getId(), operation: "sell", psbtBase64: alteredBacking.toBase64() });
  if (refusedBacking.ok || !/backing, payout, or fee mismatch/.test(refusedBacking.detail))
    throw new Error(`Guardian accepted invalid vault backing: ${JSON.stringify(refusedBacking)}`);
  const rejectedJournal = await db.execute(sql`select count(*)::int as count from cove_crc_signing_journal where network = 'regtest' and deploy_txid = ${deploy.getId()}`);
  same(rejectedJournal.rows[0]?.count, 1, "rejected v2 sells do not create signing journal rows");
  const signedSell = await service.sign({ requestId: `regtest-${ticker}-sell`, network, deploymentTxid: deploy.getId(), operation: "sell", psbtBase64: sellPsbt.toBase64() });
  if (!signedSell.ok) throw new Error(`Guardian rejected mined sell: ${signedSell.detail}`);
  const finalSellPsbt = bitcoin.Psbt.fromBase64(signedSell.signedPsbtBase64, { network: bitcoin.networks.regtest });
  if (!finalSellPsbt.data.inputs[0]?.finalScriptWitness) throw new Error("Guardian did not finalize sell vault witness");
  finalSellPsbt.finalizeInput(1);
  finalSellPsbt.finalizeInput(2);
  const sell = finalSellPsbt.extractTransaction();
  same(await rpc.call("sendrawtransaction", [sell.toHex()]), sell.getId(), "Guardian sell broadcast");
  const sellBlock = await rpc.mine(miner.address);
  synced = await syncCrcTip({ db, provider: core, network, activationHeight, protocolScriptHex, snapshot: synced.snapshot });
  same(synced.snapshot.cursor?.hash, sellBlock, "indexed Guardian sell block");
  same(synced.snapshot.state.assets[assetId]?.curve.vaultOutpoint, `${sell.getId()}:1`, "indexed Guardian sell vault");
  same(synced.snapshot.state.assets[assetId]?.curve.vaultSats, curve.vaultSats - sellQuote.grossSats, "indexed Guardian sell reserve");
  same(synced.snapshot.state.assets[assetId]?.curve.circulatingAtoms, 0n, "indexed Guardian circulating supply");
  same(synced.snapshot.state.assets[assetId]?.balances[walletScript.toString("hex")], "0", "indexed Guardian seller balance");
  same(synced.snapshot.state.assets[assetId]?.tokenUtxos?.[`${buy.getId()}:1`], undefined, "sold token outpoint consumed");
  same(synced.snapshot.state.assets[assetId]?.tokenUtxos?.[`${sell.getId()}:1`]?.atoms, "100000000000", "indexed v2 vault inventory outpoint");
  const soldCoins = await db.execute(sql`select txid, vout, atoms::text from cove_crc_token_utxos where network = 'regtest' and deploy_txid = ${deploy.getId()} order by txid, vout`);
  same(soldCoins.rows.length, 1, "one persisted v2 inventory outpoint after sell");
  same(soldCoins.rows[0]?.txid, sell.getId(), "persisted v2 vault inventory txid");
  same(soldCoins.rows[0]?.vout, 1, "persisted v2 vault inventory vout");
  same(sell.outs[2]?.value, Number(sellQuote.sellerPayoutSats + BigInt(buy.outs[1].value)), "mined seller payout and returned carrier sats");
  same(sell.outs[2]?.script.toString("hex"), walletScript.toString("hex"), "mined seller payout script");
  const persisted = await hydrateCrcLedger(db, network);
  same(persisted.state.assets[assetId]?.curve.vaultSats, curve.vaultSats - sellQuote.grossSats, "persisted sell reserve");
  same(persisted.state.assets[assetId]?.balances[walletScript.toString("hex")] ?? "0", "0", "persisted seller token balance");
  const chainVault = await rpc.call("gettxout", [sell.getId(), 1]);
  const chainPayout = await rpc.call("gettxout", [sell.getId(), 2]);
  same(chainVault ? Math.round(chainVault.value * 100_000_000) : null, Number(curve.vaultSats - sellQuote.grossSats), "Core sell vault output");
  same(chainPayout ? Math.round(chainPayout.value * 100_000_000) : null, Number(sellQuote.sellerPayoutSats + BigInt(buy.outs[1].value)), "Core seller payout output");
  const soldCurve = synced.snapshot.state.assets[assetId].curve;
  same(soldCurve.mintedAtoms, 100_000_000_000n, "supply after sell");
  same(soldCurve.vaultAtoms, 100_000_000_000n, "vault inventory after sell");
  const inventoryQuote = quoteBuy(soldCurve, 1_000n);
  same(inventoryQuote.operation, "transfer", "inventory buy marker operation");
  const inventoryFundingSats = sell.outs[4].value;
  const inventoryChangeSats = Number(soldCurve.vaultSats + BigInt(inventoryFundingSats) -
    (330n + soldCurve.vaultSats + inventoryQuote.grossSats + inventoryQuote.protocolFeeSats + inventoryQuote.creatorFeeSats) - 1_000n);
  if (inventoryChangeSats < Number(dustThreshold(walletScript))) throw new Error("inventory buy change is below dust");
  const inventoryPsbt = new bitcoin.Psbt({ network: bitcoin.networks.regtest });
  inventoryPsbt.setVersion(2);
  inventoryPsbt.addInput({ hash: sell.getId(), index: 1, witnessUtxo: { script: vault.scriptPubKey, value: Number(soldCurve.vaultSats) }, sighashType: bitcoin.Transaction.SIGHASH_ALL });
  inventoryPsbt.addInput({ hash: sell.getId(), index: 4, witnessUtxo: { script: walletScript, value: inventoryFundingSats }, sighashType: bitcoin.Transaction.SIGHASH_ALL });
  inventoryPsbt.addOutput({ script: bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, Buffer.from(JSON.stringify({ p: "crc-20", op: "transfer", tick: ticker, amt: "100000000000", id: deploy.getId(), v: 2 }))]), value: 0 });
  inventoryPsbt.addOutput({ script: walletScript, value: 330 });
  inventoryPsbt.addOutput({ script: vault.scriptPubKey, value: Number(soldCurve.vaultSats + inventoryQuote.grossSats) });
  inventoryPsbt.addOutput({ script: Buffer.from(protocolScriptHex, "hex"), value: Number(inventoryQuote.protocolFeeSats) });
  inventoryPsbt.addOutput({ script: Buffer.from(creator.scriptHex, "hex"), value: Number(inventoryQuote.creatorFeeSats) });
  inventoryPsbt.addOutput({ script: walletScript, value: inventoryChangeSats });
  inventoryPsbt.signInput(1, wallet);
  const signedInventory = await service.sign({ requestId: `regtest-${ticker}-inventory`, network, deploymentTxid: deploy.getId(), operation: "inventory-buy", psbtBase64: inventoryPsbt.toBase64() });
  if (!signedInventory.ok) throw new Error(`Guardian rejected mined inventory buy: ${signedInventory.detail}`);
  const finalInventoryPsbt = bitcoin.Psbt.fromBase64(signedInventory.signedPsbtBase64, { network: bitcoin.networks.regtest });
  if (!finalInventoryPsbt.data.inputs[0]?.finalScriptWitness) throw new Error("Guardian did not finalize inventory vault witness");
  finalInventoryPsbt.finalizeInput(1);
  const inventoryBuy = finalInventoryPsbt.extractTransaction();
  same(await rpc.call("sendrawtransaction", [inventoryBuy.toHex()]), inventoryBuy.getId(), "Guardian inventory buy broadcast");
  const inventoryBlock = await rpc.mine(miner.address);
  synced = await syncCrcTip({ db, provider: core, network, activationHeight, protocolScriptHex, snapshot: synced.snapshot });
  same(synced.snapshot.cursor?.hash, inventoryBlock, "indexed inventory buy block");
  const inventoryState = synced.snapshot.state.assets[assetId];
  same(inventoryState?.curve.vaultOutpoint, `${inventoryBuy.getId()}:2`, "indexed inventory buy vault");
  same(inventoryState?.curve.mintedAtoms, soldCurve.mintedAtoms, "inventory buy does not mint supply");
  same(inventoryState?.curve.vaultAtoms, 0n, "inventory buy clears one lot");
  same(inventoryState?.curve.vaultSats, soldCurve.vaultSats + inventoryQuote.grossSats, "inventory buy reserve");
  same(inventoryState?.balances[walletScript.toString("hex")], "100000000000", "inventory buyer balance");
  same(inventoryState?.tokenUtxos?.[`${inventoryBuy.getId()}:1`]?.atoms, "100000000000", "inventory buyer token outpoint");
  same(inventoryState?.tokenUtxos?.[`${sell.getId()}:1`], undefined, "inventory vault token outpoint consumed");
  const finalCoins = await db.execute(sql`select txid, vout, atoms::text from cove_crc_token_utxos where network = 'regtest' and deploy_txid = ${deploy.getId()} order by txid, vout`);
  same(finalCoins.rows.length, 1, "one persisted v2 buyer outpoint after inventory buy");
  same(finalCoins.rows[0]?.txid, inventoryBuy.getId(), "persisted inventory buyer token txid");
  same(finalCoins.rows[0]?.vout, 1, "persisted inventory buyer token vout");
  same(inventoryBuy.outs[3]?.value, Number(inventoryQuote.protocolFeeSats), "inventory buy protocol fee");
  same(inventoryBuy.outs[4]?.value, Number(inventoryQuote.creatorFeeSats), "inventory buy creator fee");
  const persistedInventory = await hydrateCrcLedger(db, network);
  same(persistedInventory.state.assets[assetId]?.curve.mintedAtoms, soldCurve.mintedAtoms, "persisted inventory buy minted supply");
  same(persistedInventory.state.assets[assetId]?.curve.vaultAtoms, 0n, "persisted inventory buy inventory");
  same(persistedInventory.state.assets[assetId]?.balances[walletScript.toString("hex")], "100000000000", "persisted inventory buyer balance");
  const inventoryVault = await rpc.call("gettxout", [inventoryBuy.getId(), 2]);
  same(inventoryVault ? Math.round(inventoryVault.value * 100_000_000) : null, Number(soldCurve.vaultSats + inventoryQuote.grossSats), "Core inventory buy vault output");
  const journal = await db.execute(sql`select count(*)::int as count from cove_crc_signing_journal where network = 'regtest' and deploy_txid = ${deploy.getId()} and signed_at is not null`);
  same(journal.rows[0]?.count, 3, "durable Guardian mint, sell, and inventory signatures");
  console.log(JSON.stringify({ ok: true, ticker, deployTxid: deploy.getId(), buyTxid: buy.getId(), sellTxid: sell.getId(), inventoryBuyTxid: inventoryBuy.getId(), cursor: synced.snapshot.cursor?.height, guardianJournalRows: 3 }));
  await db.execute(sql`delete from cove_crc_signing_journal where network = 'regtest'`);
  await db.execute(sql`delete from cove_crc_events where network = 'regtest'`);
  await db.execute(sql`delete from cove_crc_undo where network = 'regtest'`);
  await db.execute(sql`delete from cove_crc_blocks where network = 'regtest'`);
  await db.execute(sql`delete from cove_crc_balances where network = 'regtest'`);
  await db.execute(sql`delete from cove_crc_token_utxos where network = 'regtest'`);
  await db.execute(sql`delete from cove_crc_vaults where network = 'regtest'`);
  await db.execute(sql`delete from cove_crc_assets where network = 'regtest'`);
  await db.execute(sql`delete from cove_crc_cursor where network = 'regtest'`);
  await db.execute(sql`delete from cove_crc_launch_intents where network = 'regtest'`);
}

main().then(() => process.exit(0), (error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
