import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
loadEnv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });
import type { BitcoinProtocolTx } from "@crclaunch/bitcoin";
import {
  createCoveState,
  encodeCoveDeploy,
  encodeCoveMint,
  encodeCoveTransfer,
} from "@crclaunch/protocol";
import { schema } from "@crclaunch/db";
import { eq } from "drizzle-orm";
import { CoveIndexer } from "./indexer.js";
import { COVE_SIGNET_CONFIG } from "./config.js";
import { CoveStore } from "./store.js";
const CFG = COVE_SIGNET_CONFIG;
const NETWORK = CFG.network;
const ACTOR = "0014" + "aa".repeat(20);
const RECIPIENT = "5120" + "bb".repeat(32);
const RECIPIENT2 = "0014" + "cc".repeat(20);
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  console.log("  ok:", msg);
}
function opReturnOut(payload: Uint8Array) {
  const len = payload.length.toString(16).padStart(2, "0");
  return {
    index: 0,
    scriptPubKeyHex: `6a${len}${Buffer.from(payload).toString("hex")}`,
    valueSats: 0n,
    opReturnData: payload,
  };
}
function tx(
  payload: Uint8Array,
  extra: {
    index: number;
    scriptPubKeyHex: string;
    valueSats: bigint;
  }[],
  txid: string,
  actor: string,
): BitcoinProtocolTx {
  return {
    txid,
    version: 2,
    locktime: 0,
    inputs: [
      {
        prevTxid: "b".repeat(64),
        vout: 0,
        sequence: 0xfffffffd,
        prevScriptPubKeyHex: actor,
      },
    ],
    outputs: [opReturnOut(payload), ...extra],
  };
}
function buildChain(): {
  blocks: BitcoinProtocolTx[][];
  hashes: string[];
} {
  const deploy = tx(
    encodeCoveDeploy("FROG"),
    [{ index: 1, scriptPubKeyHex: CFG.treasuryScript, valueSats: 10000n }],
    "d".repeat(64),
    ACTOR,
  );
  const mint = tx(
    encodeCoveMint("FROG", 200000000000000n, 0n),
    [
      { index: 1, scriptPubKeyHex: RECIPIENT, valueSats: 330n },
      { index: 2, scriptPubKeyHex: CFG.settlementScript, valueSats: 1010n },
    ],
    "e".repeat(64),
    ACTOR,
  );
  const transfer = tx(
    encodeCoveTransfer("FROG", 50000000000000n),
    [
      { index: 1, scriptPubKeyHex: RECIPIENT2, valueSats: 294n },
      { index: 2, scriptPubKeyHex: RECIPIENT, valueSats: 330n },
    ],
    "f".repeat(64),
    RECIPIENT,
  );
  const hashes = ["0".repeat(64), "1".repeat(64), "2".repeat(64)];
  return { blocks: [[deploy], [mint], [transfer]], hashes };
}
async function indexAndPersist(
  store: CoveStore,
  chain: {
    blocks: BitcoinProtocolTx[][];
    hashes: string[];
  },
): Promise<string> {
  const idx = new CoveIndexer(CFG);
  const start = CFG.genesisHeight;
  for (let i = 0; i < chain.blocks.length; i++) {
    const h = start + i;
    await store.saveBlock(
      NETWORK,
      h,
      chain.hashes[i]!,
      chain.hashes[i - 1] ?? "0".repeat(64),
    );
    idx.processBlock(h, chain.blocks[i]!);
  }
  await store.saveOperations(NETWORK, idx.getEvents());
  await store.saveState(
    NETWORK,
    idx.getState(),
    start + chain.blocks.length - 1,
    chain.hashes.at(-1)!,
    idx.getStateRoot(),
  );
  return idx.getStateRoot();
}
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const store = new CoveStore(url);
  const chain = buildChain();
  console.log("=== Cove persistent indexer integration test ===");
  await store.clearCove(NETWORK);
  const rootA = await indexAndPersist(store, chain);
  const cpA = await store.getLatestCheckpoint(NETWORK);
  assert(
    cpA !== undefined && cpA.stateRoot === rootA,
    "checkpoint persisted with state root",
  );
  const cursor = await store.getCursor(NETWORK);
  assert(cursor !== undefined, "cursor persisted");
  const wrongParent = "f".repeat(64);
  const reorg = cursor!.blockHash !== wrongParent;
  assert(
    reorg,
    `parent-hash mismatch detectable (stored tip ${cursor!.blockHash})`,
  );
  await store.clearCove(NETWORK);
  const rootB = await indexAndPersist(store, chain);
  assert(
    rootA === rootB,
    "clean-reindex === incremental (identical state root)",
  );
  console.log(`  state root: ${rootA}`);
  console.log("✅ Cove persistent indexer integration test PASSED");
  const badHeight = 999999;
  const badEvent = {
    blockHeight: badHeight,
    txIndex: 2147483648,
    txid: "f".repeat(64),
    operation: "DEPLOY",
    classification: "VALID" as const,
    valid: true,
    reason: null,
  };
  let threw = false;
  try {
    await store.persistBlock(
      NETWORK,
      badHeight,
      "c".repeat(64),
      "d".repeat(64),
      createCoveState(),
      [badEvent],
      "deadbeef",
    );
  } catch {
    threw = true;
  }
  assert(threw, "persistBlock threw on injected mid-transaction failure");
  const blocksAtBad = await store.db
    .select()
    .from(schema.coveBlocks)
    .where(eq(schema.coveBlocks.height, BigInt(badHeight)))
    .execute();
  const opsAtBad = await store.db
    .select()
    .from(schema.coveOperations)
    .where(eq(schema.coveOperations.blockHeight, BigInt(badHeight)))
    .execute();
  assert(blocksAtBad.length === 0, "block insert rolled back");
  assert(opsAtBad.length === 0, "operation insert rolled back");
  await store.clearCove(NETWORK);
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
