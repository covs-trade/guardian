import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
loadEnv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });
import {
  CoreRpcProvider,
  decodeRawTransaction,
  type BitcoinBlock,
  type BitcoinProtocolTx,
} from "@crclaunch/bitcoin";
import { isCoveMagic } from "@crclaunch/protocol";
import { CoveIndexer } from "./indexer.js";
import { assertSignetChain } from "./chain-assert.js";
import { COVE_SIGNET_CONFIG } from "./config.js";
import { CoveStore } from "./store.js";
const DEFAULT_RPC_URL = "https://bitcoin-signet-rpc.publicnode.com";
const GENESIS = COVE_SIGNET_CONFIG.genesisHeight;
function argValue(flag: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (
    i >= 0 &&
    process.argv[i + 1] !== undefined &&
    !process.argv[i + 1]!.startsWith("--")
  ) {
    return process.argv[i + 1];
  }
  return fallback;
}
function intArg(flag: string, fallback: number): number {
  const v = argValue(flag);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`Invalid integer for ${flag}: ${v}`);
  }
  return n;
}
function isCoveCandidate(tx: BitcoinProtocolTx): boolean {
  for (const out of tx.outputs) {
    const data = out.opReturnData;
    if (data && isCoveMagic(data)) return true;
  }
  return false;
}
async function resolveActor(
  provider: CoreRpcProvider,
  tx: BitcoinProtocolTx,
): Promise<void> {
  const input0 = tx.inputs[0];
  if (!input0 || input0.prevScriptPubKeyHex) return;
  if (input0.prevTxid === "0".repeat(64)) return;
  const prevOut = await provider.getPrevout(input0.prevTxid, input0.vout);
  if (prevOut) input0.prevScriptPubKeyHex = prevOut.scriptPubKeyHex;
}
async function requireSignet(provider: CoreRpcProvider): Promise<void> {
  const info = await provider.getBlockchainInfo();
  if (info.chain !== "signet") {
    throw new Error(
      `Chain mismatch: expected signet, got ${info.chain}. Refusing to index.`,
    );
  }
  await assertSignetChain(provider);
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
async function fetchBlockWithRetry(
  provider: CoreRpcProvider,
  height: number,
): Promise<BitcoinBlock> {
  const hash = await readWithRetry(
    () => provider.getBlockHash(height),
    `getBlockHash ${height}`,
  );
  return readWithRetry(
    () => provider.getBlock(hash),
    `getBlock ${hash.slice(0, 8)}`,
  );
}
async function scanRange(
  provider: CoreRpcProvider,
  from: number,
  to: number,
  indexer: CoveIndexer,
): Promise<void> {
  for (let h = from; h <= to; h++) {
    const block = await fetchBlockWithRetry(provider, h);
    const txs: BitcoinProtocolTx[] = [];
    for (let i = 0; i < block.rawTxs.length; i++) {
      const raw = block.rawTxs[i]!;
      let tx: BitcoinProtocolTx;
      try {
        tx = decodeRawTransaction(raw, "signet");
      } catch (err) {
        tx = {
          txid: block.txids[i]!,
          version: 0,
          locktime: 0,
          inputs: [],
          outputs: [],
        };
        process.stderr.write(
          `  skipped undecodable tx #${i} in block ${h}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
      if (isCoveCandidate(tx)) await resolveActor(provider, tx);
      txs.push(tx);
    }
    indexer.processBlock(h, txs);
    process.stderr.write(`  indexed block ${h} (${block.rawTxs.length} txs)\n`);
  }
}
function printStats(label: string, indexer: CoveIndexer): void {
  const s = indexer.getStats();
  console.log(`\n${label}`);
  console.log(`  blocks            ${s.processedBlocks}`);
  console.log(`  transactions      ${s.processedTxs}`);
  console.log(`  cove candidates   ${s.coveCandidateTxs}`);
  console.log(`  valid ops         ${s.validOps}`);
  console.log(`  invalid ops       ${s.invalidOps}`);
  console.log(`  tokens            ${s.tokens}`);
  console.log(`  reserve sats      ${s.reserveSats}`);
  console.log(`  treasury sats     ${s.treasurySats}`);
  console.log(`  state root        ${s.stateRoot}`);
}
async function cmdIndex(): Promise<void> {
  const provider = new CoreRpcProvider({
    url: process.env.COVE_RPC_URL ?? DEFAULT_RPC_URL,
  });
  await requireSignet(provider);
  const tip = await provider.getBestHeight();
  const to = intArg("--to", tip);
  const fromFlag = argValue("--from");
  const from = fromFlag !== undefined ? intArg("--from", GENESIS) : GENESIS;
  const canonical = fromFlag === undefined;
  console.log(
    `Cove index: signet blocks ${from}..${to} (tip ${tip}, genesis ${GENESIS})`,
  );
  if (!canonical) {
    console.log(
      "  ⚠ NON-CANONICAL PARTIAL SCAN: --from is above genesis; state root is NOT canonical.",
    );
  }
  const indexer = new CoveIndexer(COVE_SIGNET_CONFIG);
  await scanRange(provider, from, to, indexer);
  printStats(
    canonical ? "Canonical indexed state" : "PARTIAL indexed state",
    indexer,
  );
  const events = indexer.getEvents();
  if (events.length > 0) {
    console.log(`\nCove activity (${events.length} events):`);
    for (const e of events) {
      console.log(
        `  h=${e.blockHeight} tx=${e.txIndex} ${e.txid} op=${e.operation} class=${e.classification} valid=${e.valid} reason=${e.reason}`,
      );
    }
  } else {
    console.log(
      "\nNo Cove operations found in the scanned range (protocol is new; expected).",
    );
  }
}
async function cmdVerify(): Promise<void> {
  const provider = new CoreRpcProvider({
    url: process.env.COVE_RPC_URL ?? DEFAULT_RPC_URL,
  });
  await requireSignet(provider);
  const tip = await provider.getBestHeight();
  const to = intArg("--to", tip);
  console.log(`Cove verify: clean state from genesis ${GENESIS}..${to}`);
  const a = new CoveIndexer(COVE_SIGNET_CONFIG);
  await scanRange(provider, GENESIS, to, a);
  const b = new CoveIndexer(COVE_SIGNET_CONFIG);
  await scanRange(provider, GENESIS, to, b);
  const ra = a.getStateRoot();
  const rb = b.getStateRoot();
  console.log(`  run A root ${ra}`);
  console.log(`  run B root ${rb}`);
  console.log(`  tokens    ${a.getStats().tokens} / ${b.getStats().tokens}`);
  console.log(
    `  valid ops ${a.getStats().validOps} / ${b.getStats().validOps}`,
  );
  if (ra === rb && a.getStats().tokens === b.getStats().tokens) {
    console.log("  REPLAY-DETERMINISTIC ✓");
  } else {
    console.error("  REPLAY MISMATCH ✗ (determinism violated)");
    process.exitCode = 1;
  }
}
function cmdStatus(): void {
  const empty = new CoveIndexer(COVE_SIGNET_CONFIG);
  console.log("Cove V1 status (Bitcoin signet)");
  console.log(`  protocol          cove`);
  console.log(`  version           1`);
  console.log(`  network           signet`);
  console.log(
    `  rpc               ${process.env.COVE_RPC_URL ?? DEFAULT_RPC_URL}`,
  );
  console.log(`  activation height ${GENESIS}`);
  console.log(
    `  settlement script ${COVE_SIGNET_CONFIG.settlementScript} (P2WPKH, signet test key)`,
  );
  console.log(
    `  treasury script   ${COVE_SIGNET_CONFIG.treasuryScript} (P2WPKH, signet test key)`,
  );
  console.log(`  launch fee        10,000 sats`);
  console.log(`  primary mint fee  1.00%`);
  console.log(`  min contribution  1,000 sats`);
  console.log(`  empty-state root  ${empty.getStateRoot()}`);
  console.log(
    `\n  NOTE: settlement/treasury are signet TEST keys (see .cove-signet-keys.json,`,
  );
  console.log(`        gitignored). Mainnet destinations are undefined.`);
}
const cmd = process.argv[2];
async function scanAndPersist(
  provider: CoreRpcProvider,
  store: CoveStore,
  indexer: CoveIndexer,
  from: number,
  to: number,
): Promise<void> {
  const network = COVE_SIGNET_CONFIG.network;
  for (let h = from; h <= to; h++) {
    const block = await fetchBlockWithRetry(provider, h);
    const txs: BitcoinProtocolTx[] = [];
    for (let i = 0; i < block.rawTxs.length; i++) {
      const raw = block.rawTxs[i]!;
      let tx: BitcoinProtocolTx;
      try {
        tx = decodeRawTransaction(raw, "signet");
      } catch (err) {
        tx = {
          txid: block.txids[i]!,
          version: 0,
          locktime: 0,
          inputs: [],
          outputs: [],
        };
        process.stderr.write(
          `  skipped undecodable tx #${i} in block ${h}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
      if (isCoveCandidate(tx)) await resolveActor(provider, tx);
      txs.push(tx);
    }
    indexer.processBlock(h, txs);
    await store.persistBlock(
      network,
      h,
      block.hash,
      block.previousBlockHash,
      indexer.getState(),
      indexer.getEvents(),
      indexer.getStateRoot(),
    );
    process.stderr.write(
      `  persisted block ${h} (${block.rawTxs.length} txs)\n`,
    );
  }
}
async function cmdWorker(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url)
    throw new Error("DATABASE_URL is not set (worker requires persistence).");
  const pollMs = Number(process.env.COVE_POLL_INTERVAL_MS ?? "15000");
  const provider = new CoreRpcProvider({
    url: process.env.COVE_RPC_URL ?? DEFAULT_RPC_URL,
  });
  await requireSignet(provider);
  const store = new CoveStore(url);
  const network = COVE_SIGNET_CONFIG.network;
  let indexer = new CoveIndexer(COVE_SIGNET_CONFIG);
  let from = GENESIS;
  const cursor = await store.getCursor(network);
  if (cursor) {
    const toHeight = Number(cursor.height);
    await scanRange(provider, GENESIS, toHeight, indexer);
    const cp = await store.getLatestCheckpoint(network);
    if (!cp || cp.height !== cursor.height) {
      throw new Error(`missing checkpoint at cursor height ${cursor.height}`);
    }
    if (cp.blockHash !== cursor.blockHash) {
      throw new Error(`checkpoint/cursor block hash mismatch at ${toHeight}`);
    }
    if (cp.stateRoot !== indexer.getStateRoot()) {
      throw new Error(
        `checkpoint mismatch at ${toHeight}: persisted ${cp.stateRoot} != replay ${indexer.getStateRoot()}`,
      );
    }
    from = toHeight + 1;
    console.log(
      `Cove worker: reconstructed to ${toHeight}, checkpoint + root verified. Resuming at ${from}.`,
    );
  } else {
    console.log(`Cove worker: starting from activation height ${GENESIS}.`);
  }
  for (;;) {
    const tip = await provider.getBestHeight();
    const stored = await store.getCursor(network);
    if (stored) {
      const storedHeight = Number(stored.height);
      const tipBackward = tip < storedHeight;
      if (tipBackward) {
        console.error(
          `REORG: tip ${tip} moved below stored cursor ${storedHeight}. Rebuilding.`,
        );
        await store.setRebuilding(network, true);
        await store.clearCove(network);
        indexer = new CoveIndexer(COVE_SIGNET_CONFIG);
        await scanAndPersist(provider, store, indexer, GENESIS, tip);
        await store.setRebuilding(network, false);
        from = tip + 1;
        continue;
      }
      let chainHashAtHeight: string;
      try {
        chainHashAtHeight = await provider.getBlockHash(storedHeight);
      } catch {
        await new Promise((r) => setTimeout(r, pollMs));
        continue;
      }
      if (chainHashAtHeight !== stored.blockHash) {
        console.error(
          `REORG: stored ${storedHeight}:${stored.blockHash.slice(0, 8)}, chain@${storedHeight}=${chainHashAtHeight.slice(0, 8)}. Rebuilding.`,
        );
        await store.setRebuilding(network, true);
        await store.clearCove(network);
        indexer = new CoveIndexer(COVE_SIGNET_CONFIG);
        await scanAndPersist(provider, store, indexer, GENESIS, tip);
        await store.setRebuilding(network, false);
        from = tip + 1;
        continue;
      }
    }
    if (from > tip) {
      await new Promise((r) => setTimeout(r, pollMs));
      continue;
    }
    await scanAndPersist(provider, store, indexer, from, tip);
    from = tip + 1;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
(async () => {
  try {
    if (cmd === "index") await cmdIndex();
    else if (cmd === "verify") await cmdVerify();
    else if (cmd === "status") cmdStatus();
    else if (cmd === "worker") await cmdWorker();
    else {
      console.error(
        "Usage: cove <index|verify|status|worker> [--from N] [--to N]",
      );
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(
      "Cove CLI error:",
      err instanceof Error ? err.message : String(err),
    );
    process.exitCode = 1;
  }
})();
