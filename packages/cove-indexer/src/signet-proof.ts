import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
loadEnv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  CoreRpcProvider,
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
  COVE_V1_SIGNET_CONFIG,
  buildCoveDeployPsbt,
  buildCoveMintPsbt,
  buildCoveTransferPsbt,
  decodeCoveEnvelope,
  isCoveMagic,
  toCoveTransaction,
  validateCoveOperation,
  type CoveState,
} from "@crclaunch/protocol";
import { CoveIndexer } from "./indexer.js";
import { assertSignetChain } from "./chain-assert.js";
import {
  decideNextAction,
  validateTicker,
  type ProofManifest,
} from "./proof-manifest.js";
const CFG = COVE_V1_SIGNET_CONFIG;
const RPC_URL =
  process.env.COVE_RPC_URL ?? "https://bitcoin-signet-rpc.publicnode.com";
const ESPLORA =
  process.env.COVE_ESPLORA_URL ?? "https://blockstream.info/signet/api";
const EXPECTED_SIGNER_ADDRESS = "tb1q3gn3xgduwymejw9vw2xayr4u2ldvc2zf05r3kx";
const B_BACKUP_PATH = fileURLToPath(
  new URL("../../../.cove-signer-b.wif", import.meta.url),
);
const MANIFEST_PATH = fileURLToPath(
  new URL("../../../.cove-proof.json", import.meta.url),
);
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
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
async function readWithRetry<T>(
  fn: () => Promise<T>,
  label: string,
  retries = 4,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
  }
  throw new Error(
    `${label} failed after ${retries} retries: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}
function localTxid(signedHex: string): string {
  return bitcoin.Transaction.fromHex(signedHex).getId();
}
async function isTxKnown(
  provider: CoreRpcProvider,
  txid: string,
): Promise<boolean> {
  try {
    await provider.getRawTransaction(txid);
    return true;
  } catch {
    return false;
  }
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
export function validatePure(
  state: CoveState,
  btcTx: BitcoinProtocolTx,
  txIndex: number,
): {
  ok: boolean;
  reason?: string;
} {
  const coveOutputs: {
    index: number;
    payload: Uint8Array;
  }[] = [];
  for (const out of btcTx.outputs) {
    if (out.scriptPubKeyHex === "6a") continue;
    const payload = parseCanonicalOpReturn(
      Buffer.from(out.scriptPubKeyHex, "hex"),
    );
    if (payload && isCoveMagic(payload))
      coveOutputs.push({ index: out.index, payload });
  }
  if (coveOutputs.length === 0) return { ok: false, reason: "NON_COVE" };
  if (coveOutputs.length > 1)
    return { ok: false, reason: "MULTIPLE_COVE_OPERATIONS" };
  if (coveOutputs[0]!.index !== 0) return { ok: false, reason: "WRONG_VOUT" };
  const decoded = decodeCoveEnvelope(coveOutputs[0]!.payload);
  if (!decoded.ok) return { ok: false, reason: decoded.reason };
  const mapped = toCoveTransaction(btcTx, decoded.envelope!, txIndex);
  if (!mapped.ok) return { ok: false, reason: mapped.reason };
  const result = validateCoveOperation(state, mapped.tx, CFG);
  return { ok: result.valid, reason: result.reason ?? undefined };
}
async function resolveSignedTxInputs(
  provider: CoreRpcProvider,
  signedHex: string,
): Promise<BitcoinProtocolTx> {
  const tx = decodeRawTransaction(signedHex, "signet");
  for (const input of tx.inputs) {
    if (input.prevTxid === "0".repeat(64)) continue;
    const prev = await provider.getPrevout(input.prevTxid, input.vout);
    if (
      !prev ||
      prev.valueSats === undefined ||
      prev.scriptPubKeyHex === undefined
    ) {
      throw new Error(
        `input ${input.prevTxid}:${input.vout} prevout not found`,
      );
    }
    input.prevScriptPubKeyHex = prev.scriptPubKeyHex;
    input.prevValueSats = prev.valueSats;
  }
  return tx;
}
export function feeRateExceedsCap(
  feeSats: bigint,
  vsize: number,
  maxFeeRateSatVb: bigint,
): boolean {
  return feeSats > maxFeeRateSatVb * BigInt(vsize);
}
export function computeFee(
  tx: BitcoinProtocolTx,
  signedHex: string,
): {
  feeSats: bigint;
  vsize: number;
  feeRate: bigint;
} {
  const inSats = tx.inputs.reduce((a, i) => {
    if (i.prevValueSats === undefined)
      throw new Error("missing input prevout value");
    return a + i.prevValueSats;
  }, 0n);
  const outSats = tx.outputs.reduce((a, o) => a + o.valueSats, 0n);
  const feeSats = inSats - outSats;
  if (feeSats < 0n)
    throw new Error(`negative fee: inputs ${inSats} < outputs ${outSats}`);
  const vsize = bitcoin.Transaction.fromHex(signedHex).virtualSize();
  const feeRate = vsize <= 0 ? 0n : feeSats / BigInt(vsize);
  return { feeSats, vsize, feeRate };
}
async function waitConfirmation(
  provider: CoreRpcProvider,
  txid: string,
): Promise<{
  height: number;
  hash: string;
  txIndex: number;
}> {
  for (let i = 0; i < 120; i++) {
    const tip = await provider.getBestHeight();
    for (let h = tip; h >= Math.max(CFG.genesisHeight, tip - 12); h--) {
      const hash = await provider.getBlockHash(h);
      const block = await provider.getBlock(hash);
      const idx = block.txids.indexOf(txid);
      if (idx >= 0) return { height: h, hash, txIndex: idx };
    }
    await new Promise((r) => setTimeout(r, 10000));
  }
  throw new Error(`Timed out waiting for confirmation of ${txid}`);
}
async function indexConfirmedBlock(
  provider: CoreRpcProvider,
  indexer: CoveIndexer,
  height: number,
  hash: string,
): Promise<void> {
  const block = await readWithRetry(
    () => provider.getBlock(hash),
    `getBlock ${hash.slice(0, 8)}`,
  );
  const txs: BitcoinProtocolTx[] = [];
  for (let i = 0; i < block.rawTxs.length; i++) {
    const raw = block.rawTxs[i]!;
    let tx: BitcoinProtocolTx;
    try {
      tx = decodeRawTransaction(raw, "signet");
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
        if (
          !prev ||
          prev.valueSats === undefined ||
          prev.scriptPubKeyHex === undefined
        ) {
          throw new Error(
            `block ${height}: cannot resolve actor prevout ${input0.prevTxid}:${input0.vout}`,
          );
        }
        input0.prevScriptPubKeyHex = prev.scriptPubKeyHex;
        input0.prevValueSats = prev.valueSats;
      }
    }
    txs.push(tx);
  }
  indexer.processBlock(height, txs);
}
async function catchUpTo(
  provider: CoreRpcProvider,
  indexer: CoveIndexer,
  from: number,
  to: number,
): Promise<void> {
  for (let h = from; h <= to; h++) {
    const hash = await readWithRetry(
      () => provider.getBlockHash(h),
      `getBlockHash ${h}`,
    );
    await indexConfirmedBlock(provider, indexer, h, hash);
  }
}
function assertEvent(
  indexer: CoveIndexer,
  txid: string,
  expectedOp: string,
): void {
  const ev = indexer.getEvents().find((e) => e.txid === txid);
  assert(ev !== undefined, `no indexed event for ${txid}`);
  assert(
    ev!.classification === "VALID" && ev!.valid,
    `event ${txid} not VALID: ${ev!.classification} ${ev!.reason}`,
  );
  assert(
    ev!.operation === expectedOp,
    `event ${txid} op ${ev!.operation} != ${expectedOp}`,
  );
}
async function broadcastSafely(
  provider: CoreRpcProvider,
  signedHex: string,
): Promise<string> {
  const txid = localTxid(signedHex);
  const pre = await provider.testMempoolAccept(signedHex, CFG.maxFeeRateSatVb);
  if (!pre.allowed)
    throw new Error(
      `testmempoolaccept rejected: ${pre.rejectReason ?? "unknown"}`,
    );
  try {
    await provider.broadcastTransaction(signedHex);
    return txid;
  } catch (err) {
    if (await isTxKnown(provider, txid)) {
      console.log(
        `  broadcast response lost but ${txid} is in mempool/chain; continuing.`,
      );
      return txid;
    }
    throw new Error(
      `broadcast failed and ${txid} not found: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
async function verifyUtxos(
  provider: CoreRpcProvider,
  utxos: ChainUtxo[],
): Promise<ChainUtxo[]> {
  const verified: ChainUtxo[] = [];
  for (const u of utxos) {
    const txout = await provider.getTxout(u.txid, u.vout);
    if (!txout)
      throw new Error(`UTXO ${u.txid}:${u.vout} is spent or missing.`);
    assert(
      txout.scriptPubKeyHex === u.scriptPubKeyHex,
      `UTXO ${u.txid}:${u.vout} scriptPubKey mismatch.`,
    );
    assert(
      txout.valueSats === u.valueSats,
      `UTXO ${u.txid}:${u.vout} value mismatch.`,
    );
    verified.push({
      ...u,
      valueSats: txout.valueSats,
      confirmations: txout.confirmations,
    });
  }
  return verified;
}
function selectCoins(
  utxos: ChainUtxo[],
  requiredSats: bigint,
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
    if (total >= requiredSats) break;
    selected.push(u);
    total += u.valueSats;
  }
  if (total < requiredSats)
    throw new Error(
      `Insufficient funds: need ${requiredSats}, have ${total} across ${utxos.length} UTXOs.`,
    );
  return { selected, total };
}
function scriptOf(signer: LocalP2WPKHSigner): string {
  return bitcoin.address
    .toOutputScript(signer.getAddress(), btcNetwork(signer.getNetwork()))
    .toString("hex");
}
async function main() {
  const signerA = new LocalP2WPKHSigner(
    readWif("COVE_WIF", "COVE_WIF_FILE"),
    "signet",
  );
  assert(
    signerA.getAddress() === EXPECTED_SIGNER_ADDRESS,
    `WIF derives ${signerA.getAddress()}, expected ${EXPECTED_SIGNER_ADDRESS}`,
  );
  console.log("✓ key control verified:", signerA.getAddress());
  let signerB: LocalP2WPKHSigner;
  if (process.env.COVE_WIF_B_FILE || process.env.COVE_WIF_B) {
    signerB = new LocalP2WPKHSigner(
      readWif("COVE_WIF_B", "COVE_WIF_B_FILE"),
      "signet",
    );
  } else if (existsSync(B_BACKUP_PATH)) {
    signerB = new LocalP2WPKHSigner(
      readFileSync(B_BACKUP_PATH, "utf8").trim(),
      "signet",
    );
  } else {
    signerB = LocalP2WPKHSigner.makeRandom("signet");
    writeFileSync(B_BACKUP_PATH, signerB.toWIF() + "\n", { mode: 0o600 });
  }
  console.log("✓ recipient signer B:", signerB.getAddress());
  const actorScript = scriptOf(signerA);
  const recipientScript = scriptOf(signerB);
  let manifest = loadManifest();
  const ticker = validateTicker(
    process.env.COVE_PROOF_TICKER ?? manifest?.ticker ?? "FROG",
  );
  if (!manifest) {
    manifest = {
      protocol: "cove",
      network: "signet",
      ticker,
      signerA: signerA.getAddress(),
      signerB: signerB.getAddress(),
    };
  } else {
    manifest.ticker = ticker;
    manifest.signerA = signerA.getAddress();
    manifest.signerB = signerB.getAddress();
  }
  saveManifest(manifest);
  console.log(`✓ proof ticker: ${ticker}`);
  const provider = new CoreRpcProvider({
    url: RPC_URL,
    maxFeeRateSatVb: CFG.maxFeeRateSatVb,
  });
  const info = await readWithRetry(
    () => provider.getBlockchainInfo(),
    "getblockchaininfo",
  );
  assert(info.chain === "signet", `chain is ${info.chain}, expected signet`);
  await assertSignetChain(provider);
  const esplora = new EsploraUtxoProvider(ESPLORA, "signet");
  async function freshUtxos(
    signer: LocalP2WPKHSigner,
    requireConfirmed: boolean,
  ): Promise<ChainUtxo[]> {
    const tip = await readWithRetry(
      () => provider.getBestHeight(),
      "getblockcount",
    );
    const discovered = await esplora.getUtxos(signer.getAddress(), tip);
    const verified = await verifyUtxos(provider, discovered);
    if (requireConfirmed) {
      const confirmed = verified.filter((u) => u.confirmations >= 1);
      assert(
        confirmed.length > 0,
        `no CONFIRMED UTXOs for ${signer.getAddress()} (unconfirmed faucet funding rejected)`,
      );
      return confirmed;
    }
    assert(verified.length > 0, `no verified UTXOs for ${signer.getAddress()}`);
    return verified;
  }
  await freshUtxos(signerA, true);
  const indexer = new CoveIndexer(CFG);
  let indexedHeight = CFG.genesisHeight - 1;
  const initialTip = await readWithRetry(
    () => provider.getBestHeight(),
    "getblockcount",
  );
  if (initialTip >= CFG.genesisHeight) {
    await catchUpTo(provider, indexer, CFG.genesisHeight, initialTip);
    indexedHeight = initialTip;
    console.log(`✓ replayed genesis ${CFG.genesisHeight} → ${initialTip}`);
  }
  async function catchUpToTip(): Promise<void> {
    const tip = await readWithRetry(
      () => provider.getBestHeight(),
      "getblockcount",
    );
    if (tip > indexedHeight) {
      await catchUpTo(provider, indexer, indexedHeight + 1, tip);
      indexedHeight = tip;
    }
  }
  async function preflight(signedHex: string): Promise<{
    feeSats: bigint;
    vsize: number;
    feeRate: bigint;
  }> {
    const tx = await resolveSignedTxInputs(provider, signedHex);
    const fee = computeFee(tx, signedHex);
    const v = validatePure(indexer.getState(), tx, 0);
    assert(v.ok, `Cove validation failed: ${v.reason}`);
    assert(
      fee.feeSats <= CFG.maxMinerFeeSats,
      `fee ${fee.feeSats} exceeds max ${CFG.maxMinerFeeSats}`,
    );
    assert(
      !feeRateExceedsCap(fee.feeSats, fee.vsize, CFG.maxFeeRateSatVb),
      `fee rate exceeds max ${CFG.maxFeeRateSatVb} sat/vB`,
    );
    return fee;
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
      await catchUpTo(provider, indexer, indexedHeight + 1, conf.height);
      indexedHeight = conf.height;
    }
    assertEvent(indexer, txid, op);
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
      const utxos = await freshUtxos(signerA, true);
      const coins = selectCoins(utxos, 10000n + 1000n);
      const psbt = buildCoveDeployPsbt({
        network: "signet",
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
      const txid = await broadcastSafely(provider, hex);
      manifest.deploy = { txid, height: 0, blockHash: "", stateRoot: "" };
      saveManifest(manifest);
      const conf = await confirmAndIndex(txid, "DEPLOY", () => {
        const token = indexer.getState().tokens.get(txid);
        assert(
          token !== undefined && token.ticker === ticker,
          "deploy token not created",
        );
        assert(token!.confirmedSupplyAtoms === 0n, "initial supply not 0");
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
      const utxos = await freshUtxos(signerA, true);
      const coins = selectCoins(utxos, 1010n + 1000n);
      const psbt = buildCoveMintPsbt({
        network: "signet",
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
      const txid = await broadcastSafely(provider, hex);
      manifest.mint = { txid, height: 0, blockHash: "", stateRoot: "" };
      saveManifest(manifest);
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
      const utxos = await freshUtxos(signerA, true);
      const coins = selectCoins(utxos, 1000n);
      const psbt = buildCoveTransferPsbt({
        network: "signet",
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
      const txid = await broadcastSafely(provider, hex);
      manifest.transfer = { txid, height: 0, blockHash: "", stateRoot: "" };
      saveManifest(manifest);
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
  console.log(`✓ state root: ${indexer.getStateRoot()}`);
  console.log("Real Cove signet lifecycle complete.");
  process.exit(0);
}
import { pathToFileURL } from "node:url";
const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => {
    console.error(
      "cove:signet-proof failed:",
      e instanceof Error ? e.message : String(e),
    );
    process.exit(1);
  });
}
