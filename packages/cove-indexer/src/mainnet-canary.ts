import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
loadEnv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  CoreRpcProvider,
  EsploraChainProvider,
  EsploraUtxoProvider,
  bitcoin,
  decodeRawTransaction,
  parseCanonicalOpReturn,
  type BitcoinProtocolTx,
  type ChainUtxo,
} from "@crclaunch/bitcoin";
import {
  COVE_V1_MAINNET_CONFIG,
  buildCoveDeployPsbt,
  buildCoveMintPsbt,
  buildCoveTransferPsbt,
  decodeCoveEnvelope,
  isCoveMagic,
  isCoveMainnetActivated,
  toCoveTransaction,
  validateCoveOperation,
  type CoveConfig,
  type CoveState,
} from "@crclaunch/protocol";
import { loadConfig, type RuntimeConfig } from "@crclaunch/config";
import { CoveIndexer } from "./indexer.js";
import { assertMainnetChain } from "./chain-assert.js";
import { computeFee, feeRateExceedsCap } from "./signet-proof.js";
import { decodeMainnetCustodyAddress } from "./mainnet-custody.js";
function esploraUrl(): string {
  return requireEnv("COVE_MAINNET_ESPLORA_URL");
}
const RPC_URL = process.env.COVE_MAINNET_RPC_URL || "";
const MANIFEST_PATH = fileURLToPath(
  new URL("../../../.cove-mainnet-canary.json", import.meta.url),
);
const MINT_AMOUNT_ATOMS = 2000000n * 100000000n;
const TRANSFER_AMOUNT_ATOMS = 500000n * 100000000n;
const MAX_ACTIVATION_REPLAY_BLOCKS = 10000;
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}
function requireEnv(key: string): string {
  const v = process.env[key]?.trim();
  if (!v) throw new Error(`${key}: REQUIRED (missing)`);
  return v;
}
function optionalEnv(key: string): string | undefined {
  const v = process.env[key]?.trim();
  return v || undefined;
}
export function assertCanaryPreflightGates(
  env: NodeJS.ProcessEnv,
): RuntimeConfig {
  const runtime = loadConfig(env);
  const { deployMainnet, mintMainnet, transferMainnet } = runtime.coveFlags;
  if (deployMainnet || mintMainnet || transferMainnet) {
    throw new Error(
      "Public write flags (COVE_DEPLOY/MINT/TRANSFER_MAINNET_ENABLED) must be false while running the owner canary. " +
        "Public staging opens only after the canary proof is recorded.",
    );
  }
  return runtime;
}
interface CanaryStep {
  unsignedPsbtBase64?: string;
  unsignedHex?: string;
  expectedTxid?: string;
  feeSats?: string;
  vsize?: number;
  broadcastTxid?: string;
  signedHex?: string;
  txid?: string;
  height?: number;
  blockHash?: string;
  stateRoot?: string;
}
interface CanaryManifest {
  protocol: "cove-mainnet-canary";
  network: "mainnet";
  ticker: string;
  activationHeight: number;
  treasuryAddress: string;
  settlementAddress: string;
  actorAddress: string;
  recipientAddress: string;
  deploy?: CanaryStep;
  mint?: CanaryStep;
  transfer?: CanaryStep;
  finalStateRoot?: string;
  replayStateRoot?: string;
  rootsEqual?: boolean;
}
type CanaryAction = "DEPLOY" | "MINT" | "TRANSFER" | "DONE";
function loadManifest(): CanaryManifest | undefined {
  if (!existsSync(MANIFEST_PATH)) return undefined;
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as CanaryManifest;
}
function saveManifest(m: CanaryManifest): void {
  writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2) + "\n", {
    mode: 0o600,
  });
}
function localTxid(hex: string): string {
  return bitcoin.Transaction.fromHex(hex).getId();
}
function stepOf(
  manifest: CanaryManifest,
  action: Exclude<CanaryAction, "DONE">,
): CanaryStep {
  if (action === "DEPLOY") return (manifest.deploy ??= {});
  if (action === "MINT") return (manifest.mint ??= {});
  return (manifest.transfer ??= {});
}
function decideNextCanaryAction(
  state: CoveState,
  manifest: CanaryManifest,
): CanaryAction {
  const dep = state.tickerIndex.get(manifest.ticker);
  if (dep === undefined) return "DEPLOY";
  const token = state.tokens.get(dep)!;
  if (token.confirmedSupplyAtoms < MINT_AMOUNT_ATOMS) return "MINT";
  const actorScript = bitcoin.address
    .toOutputScript(manifest.actorAddress, bitcoin.networks.bitcoin)
    .toString("hex");
  const recipientScript = bitcoin.address
    .toOutputScript(manifest.recipientAddress, bitcoin.networks.bitcoin)
    .toString("hex");
  const aBal = state.balances.get(actorScript)?.get(dep)?.availableAtoms ?? 0n;
  const bBal =
    state.balances.get(recipientScript)?.get(dep)?.availableAtoms ?? 0n;
  if (
    aBal === MINT_AMOUNT_ATOMS - TRANSFER_AMOUNT_ATOMS &&
    bBal === TRANSFER_AMOUNT_ATOMS
  )
    return "DONE";
  return "TRANSFER";
}
function readSignedTx(): string | undefined {
  const path = optionalEnv("COVE_MAINNET_SIGNED_TX_FILE");
  if (path) {
    if (!existsSync(path))
      throw new Error(`COVE_MAINNET_SIGNED_TX_FILE does not exist: ${path}`);
    return readFileSync(path, "utf8").trim();
  }
  return optionalEnv("COVE_MAINNET_SIGNED_TX");
}
function readSignedHex(): string | undefined {
  const raw = readSignedTx();
  if (raw) return raw;
  const psbtB64 = optionalEnv("COVE_MAINNET_SIGNED_PSBT");
  if (!psbtB64) return undefined;
  const psbt = bitcoin.Psbt.fromBase64(psbtB64, {
    network: bitcoin.networks.bitcoin,
  });
  try {
    psbt.finalizeAllInputs();
    return psbt.extractTransaction().toHex();
  } catch (e) {
    throw new Error(
      `signed PSBT is not final (all inputs must be finalized): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
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
async function actorUtxos(
  provider: EsploraChainProvider,
  utxoProvider: EsploraUtxoProvider,
  actorAddress: string,
  requireConfirmed: boolean,
): Promise<ChainUtxo[]> {
  const tip = await provider.getBestHeight();
  const discovered = await utxoProvider.getUtxos(actorAddress, tip);
  const verified = await verifyUtxos(provider, discovered);
  if (requireConfirmed) {
    const confirmed = verified.filter((u) => u.confirmations >= 1);
    assert(
      confirmed.length > 0,
      `no CONFIRMED UTXOs for actor ${actorAddress}`,
    );
    return confirmed;
  }
  assert(verified.length > 0, `no verified UTXOs for actor ${actorAddress}`);
  return verified;
}
async function resolveSignedTxInputs(
  provider: EsploraChainProvider,
  signedHex: string,
): Promise<BitcoinProtocolTx> {
  const tx = decodeRawTransaction(signedHex, "mainnet");
  for (const input of tx.inputs) {
    if (input.prevTxid === "0".repeat(64)) continue;
    const prev = await provider.getPrevout(input.prevTxid, input.vout);
    if (!prev)
      throw new Error(
        `input ${input.prevTxid}:${input.vout} prevout not found on mainnet`,
      );
    input.prevScriptPubKeyHex = prev.scriptPubKeyHex;
    input.prevValueSats = prev.valueSats;
  }
  return tx;
}
function validateCanary(
  cfg: CoveConfig,
  state: CoveState,
  btcTx: BitcoinProtocolTx,
  expectedOp: Exclude<CanaryAction, "DONE">,
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
  const opMap = {
    DEPLOY: "deploy",
    MINT: "mint",
    TRANSFER: "transfer",
  } as const;
  if (decoded.envelope!.op !== opMap[expectedOp])
    return {
      ok: false,
      reason: `expected ${expectedOp}, got ${decoded.envelope!.op}`,
    };
  const mapped = toCoveTransaction(btcTx, decoded.envelope!, 0);
  if (!mapped.ok) return { ok: false, reason: mapped.reason };
  const result = validateCoveOperation(state, mapped.tx, cfg);
  return { ok: result.valid, reason: result.reason ?? undefined };
}
async function waitConfirmation(
  provider: EsploraChainProvider,
  txid: string,
): Promise<{
  height: number;
  hash: string;
  txIndex: number;
}> {
  for (let i = 0; i < 180; i++) {
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
      tx = decodeRawTransaction(raw, "mainnet");
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
type Resolution =
  | {
      kind: "CONFIRMED";
      height: number;
    }
  | {
      kind: "MEMPOOL";
    }
  | {
      kind: "LOST";
    };
async function resolveRecorded(
  provider: EsploraChainProvider,
  txid: string,
): Promise<Resolution> {
  const st = await provider.getTxStatus(txid);
  if (st?.confirmed && st.blockHeight !== undefined && st.blockHash) {
    return { kind: "CONFIRMED", height: st.blockHeight };
  }
  if (st && !st.confirmed) return { kind: "MEMPOOL" };
  return { kind: "LOST" };
}
async function broadcastAndConfirm(
  action: Exclude<CanaryAction, "DONE">,
  signedHex: string,
  manifest: CanaryManifest,
  cfg: CoveConfig,
  indexer: CoveIndexer,
  indexedHeight: number,
  rpc: CoreRpcProvider,
): Promise<number> {
  const provider = new EsploraChainProvider(esploraUrl(), "mainnet");
  const step = stepOf(manifest, action);
  const txid = localTxid(signedHex);
  assert(
    broadcastTxidMatches(step, txid),
    `signed tx ${txid} does not match the recorded ${action} txid ${step.broadcastTxid ?? step.expectedTxid}.`,
  );
  step.broadcastTxid = txid;
  step.signedHex = signedHex;
  saveManifest(manifest);
  const pre = await rpc.testMempoolAccept(signedHex, cfg.maxFeeRateSatVb);
  assert(
    pre.allowed,
    `testmempoolaccept rejected: ${pre.rejectReason ?? "unknown"}`,
  );
  console.log(`✓ testmempoolaccept allowed before broadcast`);
  const broadcastTxid = await rpc.broadcastTransaction(signedHex);
  assert(
    broadcastTxid === txid,
    `broadcast returned ${broadcastTxid}, expected ${txid}`,
  );
  console.log(`✓ broadcast ${txid}`);
  const conf = await waitConfirmation(provider, txid);
  for (let h = indexedHeight + 1; h <= conf.height; h++) {
    await indexBlock(provider, indexer, h, await provider.getBlockHash(h));
  }
  const ev = indexer.getEvents().find((e) => e.txid === txid);
  assert(
    ev !== undefined &&
      ev.classification === "VALID" &&
      ev.valid &&
      ev.operation === action,
    `event ${txid} not VALID ${action}: ${ev?.classification} ${ev?.reason}`,
  );
  step.txid = txid;
  step.height = conf.height;
  step.blockHash = conf.hash;
  step.stateRoot = indexer.getStateRoot();
  saveManifest(manifest);
  console.log(
    `✓ ${action} ${txid} @ ${conf.height} tx=${conf.txIndex} root=${step.stateRoot}`,
  );
  return conf.height;
}
function broadcastTxidMatches(step: CanaryStep, txid: string): boolean {
  const expected = step.broadcastTxid ?? step.expectedTxid;
  if (!expected) {
    throw new Error(
      "No expected txid recorded for this step; refusing to broadcast an unbound signed transaction.",
    );
  }
  return expected === txid;
}
async function main(): Promise<void> {
  const confirmMainnet = process.argv.includes("--confirm-mainnet");
  assertCanaryPreflightGates(process.env);
  const cfg: CoveConfig = COVE_V1_MAINNET_CONFIG;
  assert(
    isCoveMainnetActivated(cfg),
    "Cove mainnet is NOT activated. Commit COVE_V1_MAINNET_CONFIG with a future H + treasury/settlement scripts before running the canary.",
  );
  const H = cfg.genesisHeight;
  const ticker = (
    optionalEnv("COVE_MAINNET_CANARY_TICKER") ?? "COVE"
  ).toUpperCase();
  assert(
    /^[A-Z0-9]{4}$/.test(ticker),
    `ticker must match [A-Z0-9]{4}, got "${ticker}"`,
  );
  const treasury = decodeMainnetCustodyAddress(
    requireEnv("COVE_MAINNET_TREASURY_ADDRESS"),
  );
  const settlement = decodeMainnetCustodyAddress(
    requireEnv("COVE_MAINNET_SETTLEMENT_ADDRESS"),
  );
  assert(
    treasury.scriptPubKeyHex === cfg.treasuryScript,
    "COVE_MAINNET_TREASURY_ADDRESS does not match committed COVE_V1_MAINNET_CONFIG.treasuryScript",
  );
  assert(
    settlement.scriptPubKeyHex === cfg.settlementScript,
    "COVE_MAINNET_SETTLEMENT_ADDRESS does not match committed COVE_V1_MAINNET_CONFIG.settlementScript",
  );
  const envH = optionalEnv("COVE_V1_MAINNET_GENESIS_HEIGHT");
  if (envH) {
    assert(
      /^\d+$/.test(envH) && Number.parseInt(envH, 10) === H,
      "COVE_V1_MAINNET_GENESIS_HEIGHT (if set) must equal committed COVE_V1_MAINNET_CONFIG.genesisHeight",
    );
  }
  const actorAddress = requireEnv("COVE_MAINNET_ACTOR_ADDRESS");
  const recipientAddress = requireEnv("COVE_MAINNET_RECIPIENT_ADDRESS");
  const actorScript = bitcoin.address
    .toOutputScript(actorAddress, bitcoin.networks.bitcoin)
    .toString("hex");
  const recipientScript = bitcoin.address
    .toOutputScript(recipientAddress, bitcoin.networks.bitcoin)
    .toString("hex");
  console.log(`✓ treasury   ${treasury.address} (${treasury.type})`);
  console.log(`✓ settlement ${settlement.address} (${settlement.type})`);
  console.log(`✓ actor      ${actorAddress}`);
  console.log(`✓ recipient  ${recipientAddress}`);
  console.log(`✓ activation H=${H} (committed literal; env may only verify)`);
  const loaded = loadManifest();
  if (loaded) {
    assert(
      loaded.ticker === ticker,
      `manifest ticker ${loaded.ticker} != env ticker ${ticker} (refusing to overwrite)`,
    );
    assert(
      loaded.activationHeight === H,
      `manifest activationHeight ${loaded.activationHeight} != committed H ${H} (refusing to overwrite)`,
    );
    assert(
      loaded.treasuryAddress === treasury.address,
      "manifest treasuryAddress != committed treasury (refusing to overwrite)",
    );
    assert(
      loaded.settlementAddress === settlement.address,
      "manifest settlementAddress != committed settlement (refusing to overwrite)",
    );
    assert(
      loaded.actorAddress === actorAddress,
      "manifest actorAddress != env actor (refusing to overwrite)",
    );
    assert(
      loaded.recipientAddress === recipientAddress,
      "manifest recipientAddress != env recipient (refusing to overwrite)",
    );
  }
  const manifest: CanaryManifest = loaded ?? {
    protocol: "cove-mainnet-canary",
    network: "mainnet",
    ticker,
    activationHeight: H,
    treasuryAddress: treasury.address,
    settlementAddress: settlement.address,
    actorAddress,
    recipientAddress,
  };
  saveManifest(manifest);
  const provider = new EsploraChainProvider(esploraUrl(), "mainnet");
  const tip = await provider.getBestHeight();
  assert(
    tip >= H,
    `chain tip ${tip} is below activation height ${H}. Wait for H before running the canary.`,
  );
  assert(
    tip - H <= MAX_ACTIVATION_REPLAY_BLOCKS,
    `activation height ${H} is too far in the past (tip ${tip}); refusing to replay ${tip - H} blocks. Re-check the committed H.`,
  );
  const indexer = new CoveIndexer(cfg);
  let indexedHeight = H - 1;
  for (let h = H; h <= tip; h++) {
    await indexBlock(provider, indexer, h, await provider.getBlockHash(h));
    indexedHeight = h;
  }
  console.log(`✓ replayed canonical state ${H} → ${tip}`);
  const rpc = confirmMainnet
    ? new CoreRpcProvider({
        url: requireEnv("COVE_MAINNET_RPC_URL"),
        maxFeeRateSatVb: cfg.maxFeeRateSatVb,
      })
    : undefined;
  if (rpc) {
    const info = await rpc.getBlockchainInfo();
    assert(info.chain === "main", `RPC chain is ${info.chain}, expected main`);
    await assertMainnetChain(rpc);
    console.log(`✓ Core RPC on mainnet (genesis verified; tip=${info.blocks})`);
  }
  for (;;) {
    const action = decideNextCanaryAction(indexer.getState(), manifest);
    if (action === "DONE") {
      await finalize(provider, manifest, indexer, cfg, indexedHeight);
      return;
    }
    const step = stepOf(manifest, action);
    if (step.broadcastTxid && !step.txid) {
      const r = await resolveRecorded(provider, step.broadcastTxid);
      if (r.kind === "CONFIRMED") {
        for (let h = indexedHeight + 1; h <= r.height; h++) {
          await indexBlock(
            provider,
            indexer,
            h,
            await provider.getBlockHash(h),
          );
        }
        const ev = indexer
          .getEvents()
          .find((e) => e.txid === step.broadcastTxid);
        assert(
          ev !== undefined &&
            ev.classification === "VALID" &&
            ev.valid &&
            ev.operation === action,
          `recorded ${action} ${step.broadcastTxid} not VALID after indexing: ${ev?.classification} ${ev?.reason}`,
        );
        step.txid = step.broadcastTxid;
        step.height = r.height;
        step.stateRoot = indexer.getStateRoot();
        saveManifest(manifest);
        indexedHeight = Math.max(indexedHeight, r.height);
        console.log(
          `✓ resolved recorded ${action} ${step.broadcastTxid} as confirmed @ ${r.height}`,
        );
        continue;
      }
      if (r.kind === "MEMPOOL") {
        console.log(
          `recorded ${action} ${step.broadcastTxid} is in the mempool (unconfirmed). Awaiting confirmation — NOT constructing a replacement.`,
        );
        process.exit(0);
      }
      if (confirmMainnet && step.signedHex) {
        console.log(
          `recorded ${action} ${step.broadcastTxid} is not in mempool/chain. Re-broadcasting the SAME signed tx (never a replacement).`,
        );
        indexedHeight = await broadcastAndConfirm(
          action,
          step.signedHex,
          manifest,
          cfg,
          indexer,
          indexedHeight,
          rpc!,
        );
        continue;
      }
      console.log(
        `recorded ${action} ${step.broadcastTxid} is not in mempool/chain. Re-run with --confirm-mainnet to re-broadcast the SAME tx; refusing to construct a replacement.`,
      );
      process.exit(0);
    }
    const signedHex = readSignedHex();
    if (!signedHex) {
      await buildAndExport(action, manifest, cfg, actorScript, recipientScript);
      return;
    }
    const txid = localTxid(signedHex);
    if (step.broadcastTxid && step.broadcastTxid !== txid) {
      throw new Error(
        `provided signed tx ${txid} does not match recorded ${action} txid ${step.broadcastTxid}.`,
      );
    }
    const tx = await resolveSignedTxInputs(provider, signedHex);
    const v = validateCanary(cfg, indexer.getState(), tx, action);
    assert(v.ok, `Cove ${action} validation failed: ${v.reason}`);
    const fee = computeFee(tx, signedHex);
    assert(
      fee.feeSats <= cfg.maxMinerFeeSats,
      `fee ${fee.feeSats} exceeds max ${cfg.maxMinerFeeSats}`,
    );
    assert(
      !feeRateExceedsCap(fee.feeSats, fee.vsize, cfg.maxFeeRateSatVb),
      `fee rate exceeds max ${cfg.maxFeeRateSatVb} sat/vB`,
    );
    console.log(`✓ imported + decoded signed ${action} tx`);
    console.log(`  txid     ${txid}`);
    console.log(
      `  fee      ${fee.feeSats} sats (${fee.vsize} vB, ${fee.feeRate} sat/vB)`,
    );
    if (confirmMainnet) {
      const pre = await rpc!.testMempoolAccept(signedHex, cfg.maxFeeRateSatVb);
      assert(
        pre.allowed,
        `testmempoolaccept rejected: ${pre.rejectReason ?? "unknown"}`,
      );
      console.log(`✓ testmempoolaccept allowed`);
    } else if (RPC_URL) {
      const pre = await new CoreRpcProvider({
        url: RPC_URL,
        maxFeeRateSatVb: cfg.maxFeeRateSatVb,
      }).testMempoolAccept(signedHex, cfg.maxFeeRateSatVb);
      assert(
        pre.allowed,
        `testmempoolaccept rejected: ${pre.rejectReason ?? "unknown"}`,
      );
      console.log(`✓ testmempoolaccept allowed (preflight; no broadcast)`);
    } else {
      console.log(
        "⚠ no COVE_MAINNET_RPC_URL set — skipped testmempoolaccept (broadcast is disabled without --confirm-mainnet).",
      );
    }
    if (!confirmMainnet) {
      console.log();
      console.log(
        `SUMMARY: ${action} is signed, decoded, prevouts resolved, pure-validated, and fee-checked.`,
      );
      console.log(
        "No broadcast occurred. Re-run with --confirm-mainnet to broadcast + confirm.",
      );
      process.exit(0);
    }
    indexedHeight = await broadcastAndConfirm(
      action,
      signedHex,
      manifest,
      cfg,
      indexer,
      indexedHeight,
      rpc!,
    );
  }
}
async function buildAndExport(
  action: Exclude<CanaryAction, "DONE">,
  manifest: CanaryManifest,
  cfg: CoveConfig,
  actorScript: string,
  recipientScript: string,
): Promise<void> {
  const provider = new EsploraChainProvider(esploraUrl(), "mainnet");
  const utxoProvider = new EsploraUtxoProvider(esploraUrl(), "mainnet");
  const feeRate = BigInt(optionalEnv("COVE_MAINNET_FEE_RATE_SATVB") ?? "5");
  let psbt: {
    psbtBase64: string;
    unsignedHex: string;
    feeSats: bigint;
  };
  if (action === "DEPLOY") {
    const coins = selectCoins(
      await actorUtxos(provider, utxoProvider, manifest.actorAddress, true),
      cfg.launchFeeSats + feeRate * 200n,
    );
    psbt = buildCoveDeployPsbt({
      network: "mainnet",
      ticker: manifest.ticker,
      inputs: coins.selected,
      changeAddress: manifest.actorAddress,
      feeRateSatVb: feeRate,
      config: cfg,
    });
  } else if (action === "MINT") {
    const coins = selectCoins(
      await actorUtxos(provider, utxoProvider, manifest.actorAddress, true),
      1010n + feeRate * 400n,
    );
    psbt = buildCoveMintPsbt({
      network: "mainnet",
      ticker: manifest.ticker,
      amountAtoms: MINT_AMOUNT_ATOMS,
      supplyBeforeAtoms: 0n,
      recipientScriptHex: actorScript,
      inputs: coins.selected,
      changeAddress: manifest.actorAddress,
      feeRateSatVb: feeRate,
      config: cfg,
    });
  } else {
    const coins = selectCoins(
      await actorUtxos(provider, utxoProvider, manifest.actorAddress, true),
      feeRate * 400n,
    );
    psbt = buildCoveTransferPsbt({
      network: "mainnet",
      ticker: manifest.ticker,
      amountAtoms: TRANSFER_AMOUNT_ATOMS,
      recipientScriptHex: recipientScript,
      actorScriptHex: actorScript,
      inputs: coins.selected,
      changeAddress: manifest.actorAddress,
      feeRateSatVb: feeRate,
      config: cfg,
    });
  }
  const step = stepOf(manifest, action);
  step.unsignedPsbtBase64 = psbt.psbtBase64;
  step.unsignedHex = psbt.unsignedHex;
  step.expectedTxid = localTxid(psbt.unsignedHex);
  step.feeSats = psbt.feeSats.toString();
  step.vsize = bitcoin.Transaction.fromHex(psbt.unsignedHex).virtualSize();
  saveManifest(manifest);
  console.log(`✓ built unsigned ${action} PSBT (no keys held)`);
  console.log(`  txid (deterministic) ${step.expectedTxid}`);
  console.log(`  fee                 ${step.feeSats} sats (${step.vsize} vB)`);
  console.log();
  console.log("EXPORT — sign EXTERNALLY, then re-run with the signed raw tx:");
  console.log(`  Unsigned PSBT (base64):\n${psbt.psbtBase64}\n`);
  console.log(`  Unsigned raw tx (hex):\n${psbt.unsignedHex}\n`);
  console.log(
    `  COVE_MAINNET_SIGNED_TX=<signed-hex> pnpm cove:mainnet-canary            # validate + summarize`,
  );
  console.log(
    `  COVE_MAINNET_SIGNED_TX=<signed-hex> pnpm cove:mainnet-canary --confirm-mainnet  # broadcast + confirm`,
  );
  process.exit(0);
}
async function finalize(
  provider: EsploraChainProvider,
  manifest: CanaryManifest,
  indexer: CoveIndexer,
  cfg: CoveConfig,
  indexedHeight: number,
): Promise<void> {
  const liveRoot = indexer.getStateRoot();
  const clean = new CoveIndexer(cfg);
  const tip = Math.max(await provider.getBestHeight(), indexedHeight);
  for (let h = cfg.genesisHeight; h <= tip; h++) {
    await indexBlock(provider, clean, h, await provider.getBlockHash(h));
  }
  const replayRoot = clean.getStateRoot();
  manifest.finalStateRoot = liveRoot;
  manifest.replayStateRoot = replayRoot;
  manifest.rootsEqual = liveRoot === replayRoot;
  saveManifest(manifest);
  console.log(`✓ final state root     ${liveRoot}`);
  console.log(`✓ clean replay root    ${replayRoot}`);
  assert(
    liveRoot === replayRoot,
    `ROOT MISMATCH: final ${liveRoot} != replay ${replayRoot}`,
  );
  console.log(
    "✓✓ MAINNET CANARY COMPLETE (DEPLOY → MINT → TRANSFER → restart → clean replay) ✓✓",
  );
  console.log(`  DEPLOY   ${manifest.deploy?.txid ?? "?"}`);
  console.log(`  MINT     ${manifest.mint?.txid ?? "?"}`);
  console.log(`  TRANSFER ${manifest.transfer?.txid ?? "?"}`);
  console.log(`  rootsEqual ${manifest.rootsEqual}`);
  console.log();
  console.log(
    "To activate OWNER_CANARY (public writes still closed), commit the canary proof in .env:",
  );
  console.log(
    `  COVE_V1_MAINNET_CANARY_DEPLOY_TXID=${manifest.deploy?.txid ?? ""}`,
  );
  console.log(
    `  COVE_V1_MAINNET_CANARY_MINT_TXID=${manifest.mint?.txid ?? ""}`,
  );
  console.log(
    `  COVE_V1_MAINNET_CANARY_TRANSFER_TXID=${manifest.transfer?.txid ?? ""}`,
  );
  console.log(`  COVE_V1_MAINNET_CANARY_STATE_ROOT=${liveRoot}`);
  console.log(`  COVE_V1_MAINNET_CANARY_REPLAY_ROOT=${replayRoot}`);
  console.log(`  COVE_MAINNET_ENABLED=true`);
  console.log(
    "(COVE_V1_MAINNET_GENESIS_HEIGHT is the committed literal COVE_V1_MAINNET_CONFIG.genesisHeight; env only verifies it.)",
  );
  console.log(
    "Only after the FULL canary proof is recorded may you enable COVE_DEPLOY/MINT/TRANSFER_MAINNET_ENABLED.",
  );
  process.exit(0);
}
import { pathToFileURL } from "node:url";
const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => {
    console.error(
      "mainnet-canary failed:",
      e instanceof Error ? e.message : String(e),
    );
    process.exit(1);
  });
}
