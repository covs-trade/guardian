import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
loadEnv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  EsploraChainProvider,
  EsploraUtxoProvider,
  LocalP2WPKHSigner,
  bitcoin,
  btcNetwork,
  decodeRawTransaction,
  parseCanonicalOpReturn,
  psbtIntent,
  type BitcoinProtocolTx,
  type ChainUtxo,
} from "@crclaunch/bitcoin";
import {
  COVE_MUTINYNET_CONFIG,
  buildCoveDeployPsbt,
  buildCoveMintPsbt,
  buildCoveTransferPsbt,
  isCoveMagic,
} from "@crclaunch/protocol";
import { CoveIndexer } from "./indexer.js";
import { assertSignetChain } from "./chain-assert.js";
import { computeFee, feeRateExceedsCap, validatePure } from "./signet-proof.js";
import {
  decideNextAction,
  validateTicker,
  type ProofManifest,
} from "./proof-manifest.js";
const CFG = COVE_MUTINYNET_CONFIG;
const ESPLORA =
  process.env.COVE_MUTINYNET_ESPLORA_URL || "https://mutinynet.com/api";
const SIGNER_A = "tb1q3gn3xgduwymejw9vw2xayr4u2ldvc2zf05r3kx";
const B_BACKUP_PATH = fileURLToPath(
  new URL("../../../.cove-mutinynet-signer-b.wif", import.meta.url),
);
const MANIFEST_PATH = fileURLToPath(
  new URL("../../../.cove-mutinynet-proof.json", import.meta.url),
);
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}
function readWif(envKey: string, fileKey: string): string {
  const file = process.env[fileKey];
  if (file) {
    if (!existsSync(file))
      throw new Error(`${fileKey} path does not exist: ${file}`);
    return readFileSync(file, "utf8").trim();
  }
  const env = process.env[envKey];
  if (env) return env.trim();
  throw new Error(
    `Set ${fileKey} (path) or ${envKey} (env) to a signer WIF. It is never printed.`,
  );
}
function scriptOf(signer: LocalP2WPKHSigner): string {
  return bitcoin.address
    .toOutputScript(signer.getAddress(), btcNetwork(signer.getNetwork()))
    .toString("hex");
}
function loadManifest(): ProofManifest | undefined {
  if (!existsSync(MANIFEST_PATH)) return undefined;
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as ProofManifest;
}
function saveManifest(m: ProofManifest): void {
  writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2) + "\n", {
    mode: 0o600,
  });
}
async function verifyUtxos(
  provider: EsploraChainProvider,
  utxos: ChainUtxo[],
): Promise<ChainUtxo[]> {
  const verified: ChainUtxo[] = [];
  for (const u of utxos) {
    const prev = await provider.getPrevout(u.txid, u.vout);
    if (!prev) throw new Error(`UTXO ${u.txid}:${u.vout} missing on chain`);
    assert(
      prev.scriptPubKeyHex === u.scriptPubKeyHex,
      `UTXO ${u.txid}:${u.vout} script mismatch`,
    );
    assert(
      prev.valueSats === u.valueSats,
      `UTXO ${u.txid}:${u.vout} value mismatch`,
    );
    verified.push(prev);
  }
  return verified;
}
function selectCoins(
  utxos: ChainUtxo[],
  required: bigint,
): {
  selected: ChainUtxo[];
  total: bigint;
} {
  const sorted = [...utxos].sort((a, b) =>
    b.valueSats < a.valueSats ? -1 : b.valueSats > a.valueSats ? 1 : 0,
  );
  const selected: ChainUtxo[] = [];
  let total = 0n;
  for (const u of sorted) {
    if (total >= required) break;
    selected.push(u);
    total += u.valueSats;
  }
  if (total < required)
    throw new Error(
      `Insufficient funds: need ${required}, have ${total} across ${utxos.length} UTXOs`,
    );
  return { selected, total };
}
async function resolveSignedTxInputs(
  provider: EsploraChainProvider,
  signedHex: string,
): Promise<BitcoinProtocolTx> {
  const tx = decodeRawTransaction(signedHex, "mutinynet");
  for (const input of tx.inputs) {
    if (input.prevTxid === "0".repeat(64)) continue;
    const prev = await provider.getPrevout(input.prevTxid, input.vout);
    if (!prev)
      throw new Error(
        `input ${input.prevTxid}:${input.vout} prevout not found`,
      );
    input.prevScriptPubKeyHex = prev.scriptPubKeyHex;
    input.prevValueSats = prev.valueSats;
  }
  return tx;
}
async function indexBlock(
  provider: EsploraChainProvider,
  indexer: CoveIndexer,
  height: number,
  hash: string,
): Promise<void> {
  const block = await provider.getBlock(hash);
  const txs: BitcoinProtocolTx[] = [];
  for (let i = 0; i < block.rawTxs.length; i++) {
    const raw = block.rawTxs[i]!;
    let tx: BitcoinProtocolTx;
    try {
      tx = decodeRawTransaction(raw, "mutinynet");
    } catch {
      tx = {
        txid: block.txids[i]!,
        version: 0,
        locktime: 0,
        inputs: [],
        outputs: [],
      };
    }
    const isCove = tx.outputs.some((o) => {
      if (o.scriptPubKeyHex === "6a") return false;
      const p = parseCanonicalOpReturn(Buffer.from(o.scriptPubKeyHex, "hex"));
      return !!p && isCoveMagic(p);
    });
    if (isCove) {
      const input0 = tx.inputs[0]!;
      if (input0.prevTxid !== "0".repeat(64)) {
        const prev = await provider.getPrevout(input0.prevTxid, input0.vout);
        if (!prev)
          throw new Error(
            `cannot resolve actor prevout ${input0.prevTxid}:${input0.vout}`,
          );
        input0.prevScriptPubKeyHex = prev.scriptPubKeyHex;
        input0.prevValueSats = prev.valueSats;
      }
    }
    txs.push(tx);
  }
  indexer.processBlock(height, txs);
}
async function waitConfirmation(
  provider: EsploraChainProvider,
  txid: string,
): Promise<{
  height: number;
  hash: string;
  txIndex: number;
}> {
  for (let i = 0; i < 120; i++) {
    const st = await provider.getTxStatus(txid);
    if (st?.confirmed && st.blockHeight !== undefined && st.blockHash) {
      const block = await provider.getBlock(st.blockHash);
      const idx = block.txids.indexOf(txid);
      if (idx >= 0)
        return { height: st.blockHeight, hash: st.blockHash, txIndex: idx };
    }
    await new Promise((r) => setTimeout(r, 10000));
  }
  throw new Error(`Timed out waiting for confirmation of ${txid}`);
}
async function main() {
  const signerA = new LocalP2WPKHSigner(
    readWif("COVE_MUTINYNET_WIF", "COVE_MUTINYNET_WIF_FILE"),
    "mutinynet",
  );
  assert(
    signerA.getAddress() === SIGNER_A,
    `WIF derives ${signerA.getAddress()}, expected ${SIGNER_A}`,
  );
  console.log("✓ key control verified:", signerA.getAddress());
  let signerB: LocalP2WPKHSigner;
  if (
    process.env.COVE_MUTINYNET_WIF_B_FILE ||
    process.env.COVE_MUTINYNET_WIF_B
  ) {
    signerB = new LocalP2WPKHSigner(
      readWif("COVE_MUTINYNET_WIF_B", "COVE_MUTINYNET_WIF_B_FILE"),
      "mutinynet",
    );
  } else if (existsSync(B_BACKUP_PATH)) {
    signerB = new LocalP2WPKHSigner(
      readFileSync(B_BACKUP_PATH, "utf8").trim(),
      "mutinynet",
    );
  } else {
    signerB = LocalP2WPKHSigner.makeRandom("mutinynet");
    writeFileSync(B_BACKUP_PATH, signerB.toWIF() + "\n", { mode: 0o600 });
  }
  console.log("✓ recipient signer B:", signerB.getAddress());
  const actorScript = scriptOf(signerA);
  const recipientScript = scriptOf(signerB);
  const provider = new EsploraChainProvider(ESPLORA, "mutinynet");
  await assertSignetChain(provider);
  const utxoProvider = new EsploraUtxoProvider(ESPLORA, "mutinynet");
  const loaded = loadManifest();
  const ticker = validateTicker(
    process.env.COVE_PROOF_TICKER ?? loaded?.ticker ?? "FROG",
  );
  const resume = loaded?.ticker === ticker ? loaded : undefined;
  if (loaded && !resume) {
    console.log(
      `ℹ ticker changed ${loaded.ticker} → ${ticker}; starting a fresh proof run.`,
    );
  }
  const manifest: ProofManifest = {
    ...(resume ?? {}),
    protocol: "cove",
    network: "mutinynet",
    ticker,
    signerA: signerA.getAddress(),
    signerB: signerB.getAddress(),
  };
  saveManifest(manifest);
  console.log(`✓ proof ticker: ${ticker} (activation ${CFG.genesisHeight})`);
  const tip = await provider.getBestHeight();
  const discovered = await utxoProvider.getUtxos(signerA.getAddress(), tip);
  const utxos = await verifyUtxos(provider, discovered);
  const confirmed = utxos.filter((u) => u.confirmations >= 1);
  assert(confirmed.length > 0, "no confirmed funding UTXOs");
  const funding = confirmed[0]!;
  console.log(
    `✓ funding ${funding.txid}:${funding.vout} value=${funding.valueSats} confirmations=${funding.confirmations}`,
  );
  const indexer = new CoveIndexer(CFG);
  let indexedHeight = CFG.genesisHeight - 1;
  if (tip >= CFG.genesisHeight) {
    for (let h = CFG.genesisHeight; h <= tip; h++) {
      const hash = await provider.getBlockHash(h);
      await indexBlock(provider, indexer, h, hash);
    }
    indexedHeight = tip;
    console.log(`✓ replayed ${CFG.genesisHeight} → ${tip}`);
  }
  async function catchUpToTip(): Promise<void> {
    const t = await provider.getBestHeight();
    if (t > indexedHeight) {
      for (let h = indexedHeight + 1; h <= t; h++) {
        await indexBlock(provider, indexer, h, await provider.getBlockHash(h));
      }
      indexedHeight = t;
    }
  }
  async function preflight(hex: string): Promise<{
    feeSats: bigint;
    vsize: number;
  }> {
    const tx = await resolveSignedTxInputs(provider, hex);
    const fee = computeFee(tx, hex);
    const v = validatePure(indexer.getState(), tx, 0);
    assert(v.ok, `Cove validation failed: ${v.reason}`);
    assert(
      fee.feeSats <= CFG.maxMinerFeeSats,
      `fee ${fee.feeSats} exceeds max ${CFG.maxMinerFeeSats}`,
    );
    assert(
      !feeRateExceedsCap(fee.feeSats, fee.vsize, CFG.maxFeeRateSatVb),
      "fee rate exceeds max",
    );
    return { feeSats: fee.feeSats, vsize: fee.vsize };
  }
  async function broadcastSafely(hex: string): Promise<string> {
    const txid = bitcoin.Transaction.fromHex(hex).getId();
    try {
      const returned = await provider.broadcastTransaction(hex);
      if (returned !== txid)
        throw new Error(`Esplora returned txid ${returned}, expected ${txid}`);
      return txid;
    } catch (err) {
      const st = await provider.getTxStatus(txid);
      if (st) {
        console.log(
          `  broadcast response lost but ${txid} is observable in mempool/chain; continuing.`,
        );
        return txid;
      }
      throw new Error(
        `broadcast failed and ${txid} not found: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  async function confirmAndIndex(
    txid: string,
    op: string,
    assertState: () => void,
  ): Promise<{
    height: number;
    txIndex: number;
    stateRoot: string;
  }> {
    const conf = await waitConfirmation(provider, txid);
    if (conf.height > indexedHeight) {
      for (let h = indexedHeight + 1; h <= conf.height; h++)
        await indexBlock(provider, indexer, h, await provider.getBlockHash(h));
      indexedHeight = conf.height;
    }
    const ev = indexer.getEvents().find((e) => e.txid === txid);
    assert(
      ev !== undefined && ev.classification === "VALID" && ev.operation === op,
      `event ${txid} not VALID ${op}: ${ev?.classification} ${ev?.reason}`,
    );
    assertState();
    return {
      height: conf.height,
      txIndex: conf.txIndex,
      stateRoot: indexer.getStateRoot(),
    };
  }
  const mintAmount = 2000000n * 100000000n;
  const transferAmount = 500000n * 100000000n;
  let decision = decideNextAction(
    manifest,
    indexer.getState(),
    actorScript,
    recipientScript,
    mintAmount,
    transferAmount,
  );
  let iterations = 0;
  let cumulativeFee = 0n;
  while (decision.action !== "DONE") {
    if (decision.action === "BLOCKED_UNRESOLVED") {
      throw new Error(
        `Proof blocked (a recorded step is unresolved): ${decision.reason}`,
      );
    }
    if (++iterations > 10) {
      throw new Error(
        "Proof loop exceeded 10 iterations; aborting (no unbounded rebuild).",
      );
    }
    if (decision.action === "DEPLOY") {
      await catchUpToTip();
      const coins = selectCoins(
        await verifyUtxos(
          provider,
          await utxoProvider.getUtxos(
            signerA.getAddress(),
            await provider.getBestHeight(),
          ),
        ),
        10000n + 1000n,
      );
      const psbt = buildCoveDeployPsbt({
        network: "mutinynet",
        ticker,
        inputs: coins.selected,
        changeAddress: signerA.getAddress(),
        feeRateSatVb: 2n,
        config: CFG,
      });
      const hex = await signerA.signPsbt(
        psbt.psbtBase64,
        psbtIntent(psbt.unsignedHex, {
          maxFeeSats: CFG.maxMinerFeeSats,
          changeScriptPubKeyHex: psbt.changeSats > 0n ? actorScript : undefined,
        }),
      );
      const fee = await preflight(hex);
      cumulativeFee += fee.feeSats;
      if (cumulativeFee > CFG.maxMinerFeeSats * 10n)
        throw new Error(`cumulative proof fee ${cumulativeFee} exceeds cap`);
      const txid = bitcoin.Transaction.fromHex(hex).getId();
      manifest.deploy = { txid, height: 0, blockHash: "", stateRoot: "" };
      saveManifest(manifest);
      const broadcastTxid = await broadcastSafely(hex);
      assert(
        broadcastTxid === txid,
        `broadcast returned ${broadcastTxid}, expected ${txid}`,
      );
      const conf = await confirmAndIndex(txid, "DEPLOY", () => {
        const t = indexer.getState().tokens.get(txid);
        assert(
          t !== undefined && t.ticker === ticker,
          "deploy token not created",
        );
      });
      manifest.deploy = {
        txid,
        height: conf.height,
        blockHash: "",
        stateRoot: conf.stateRoot,
      };
      saveManifest(manifest);
      console.log(
        `✓ DEPLOY ${txid} @ ${conf.height} tx=${conf.txIndex} fee=${fee.feeSats}`,
      );
    } else if (decision.action === "MINT") {
      await catchUpToTip();
      const coins = selectCoins(
        await verifyUtxos(
          provider,
          await utxoProvider.getUtxos(
            signerA.getAddress(),
            await provider.getBestHeight(),
          ),
        ),
        1010n + 1000n,
      );
      const psbt = buildCoveMintPsbt({
        network: "mutinynet",
        ticker,
        amountAtoms: mintAmount,
        supplyBeforeAtoms: 0n,
        recipientScriptHex: actorScript,
        inputs: coins.selected,
        changeAddress: signerA.getAddress(),
        feeRateSatVb: 2n,
        config: CFG,
      });
      const hex = await signerA.signPsbt(
        psbt.psbtBase64,
        psbtIntent(psbt.unsignedHex, {
          maxFeeSats: CFG.maxMinerFeeSats,
          changeScriptPubKeyHex: psbt.changeSats > 0n ? actorScript : undefined,
        }),
      );
      const fee = await preflight(hex);
      cumulativeFee += fee.feeSats;
      if (cumulativeFee > CFG.maxMinerFeeSats * 10n)
        throw new Error(`cumulative proof fee ${cumulativeFee} exceeds cap`);
      const txid = bitcoin.Transaction.fromHex(hex).getId();
      manifest.mint = { txid, height: 0, blockHash: "", stateRoot: "" };
      saveManifest(manifest);
      const broadcastTxid = await broadcastSafely(hex);
      assert(
        broadcastTxid === txid,
        `broadcast returned ${broadcastTxid}, expected ${txid}`,
      );
      const conf = await confirmAndIndex(txid, "MINT", () => {
        const dep = indexer.getState().tickerIndex.get(ticker)!;
        assert(
          indexer.getState().tokens.get(dep)!.confirmedSupplyAtoms ===
            mintAmount,
          "mint supply wrong",
        );
        assert(
          indexer.getState().balances.get(actorScript)?.get(dep)
            ?.availableAtoms === mintAmount,
          "mint balance wrong",
        );
      });
      manifest.mint = {
        txid,
        height: conf.height,
        blockHash: "",
        stateRoot: conf.stateRoot,
      };
      saveManifest(manifest);
      console.log(
        `✓ MINT ${txid} @ ${conf.height} tx=${conf.txIndex} fee=${fee.feeSats}`,
      );
    } else if (decision.action === "TRANSFER") {
      await catchUpToTip();
      const coins = selectCoins(
        await verifyUtxos(
          provider,
          await utxoProvider.getUtxos(
            signerA.getAddress(),
            await provider.getBestHeight(),
          ),
        ),
        1000n,
      );
      const psbt = buildCoveTransferPsbt({
        network: "mutinynet",
        ticker,
        amountAtoms: transferAmount,
        recipientScriptHex: recipientScript,
        actorScriptHex: actorScript,
        inputs: coins.selected,
        changeAddress: signerA.getAddress(),
        feeRateSatVb: 2n,
        config: CFG,
      });
      const hex = await signerA.signPsbt(
        psbt.psbtBase64,
        psbtIntent(psbt.unsignedHex, {
          maxFeeSats: CFG.maxMinerFeeSats,
          changeScriptPubKeyHex: psbt.changeSats > 0n ? actorScript : undefined,
        }),
      );
      const fee = await preflight(hex);
      cumulativeFee += fee.feeSats;
      if (cumulativeFee > CFG.maxMinerFeeSats * 10n)
        throw new Error(`cumulative proof fee ${cumulativeFee} exceeds cap`);
      const txid = bitcoin.Transaction.fromHex(hex).getId();
      manifest.transfer = { txid, height: 0, blockHash: "", stateRoot: "" };
      saveManifest(manifest);
      const broadcastTxid = await broadcastSafely(hex);
      assert(
        broadcastTxid === txid,
        `broadcast returned ${broadcastTxid}, expected ${txid}`,
      );
      const conf = await confirmAndIndex(txid, "TRANSFER", () => {
        const dep = indexer.getState().tickerIndex.get(ticker)!;
        assert(
          indexer.getState().balances.get(actorScript)?.get(dep)
            ?.availableAtoms ===
            mintAmount - transferAmount,
          "A balance wrong",
        );
        assert(
          indexer.getState().balances.get(recipientScript)?.get(dep)
            ?.availableAtoms === transferAmount,
          "B balance wrong",
        );
      });
      manifest.transfer = {
        txid,
        height: conf.height,
        blockHash: "",
        stateRoot: conf.stateRoot,
      };
      saveManifest(manifest);
      console.log(
        `✓ TRANSFER ${txid} @ ${conf.height} tx=${conf.txIndex} fee=${fee.feeSats}`,
      );
    }
    decision = decideNextAction(
      manifest,
      indexer.getState(),
      actorScript,
      recipientScript,
      mintAmount,
      transferAmount,
    );
  }
  const liveRoot = indexer.getStateRoot();
  const clean = new CoveIndexer(CFG);
  const tipFinal = Math.max(await provider.getBestHeight(), indexedHeight);
  for (let h = CFG.genesisHeight; h <= tipFinal; h++) {
    await indexBlock(provider, clean, h, await provider.getBlockHash(h));
  }
  const replayRoot = clean.getStateRoot();
  console.log(`✓ live root      ${liveRoot}`);
  console.log(`✓ clean replay   ${replayRoot}`);
  assert(
    liveRoot === replayRoot,
    `ROOT MISMATCH: live ${liveRoot} != replay ${replayRoot}`,
  );
  console.log(
    `✓ state: ticker=${ticker} supply=${mintAmount} A=${mintAmount - transferAmount} B=${transferAmount}`,
  );
  console.log("REAL BITCOIN CUSTOM-SIGNET PROOF — MUTINYNET");
  process.exit(0);
}
import { pathToFileURL } from "node:url";
const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => {
    console.error(
      "mutinynet-proof failed:",
      e instanceof Error ? e.message : String(e),
    );
    process.exit(1);
  });
}
