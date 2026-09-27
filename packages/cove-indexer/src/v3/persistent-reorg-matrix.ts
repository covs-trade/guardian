import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { CoreRpcProvider } from "@crclaunch/bitcoin";
import { createDb, schema } from "@crclaunch/db";
import { eq, and } from "drizzle-orm";
import { TOKEN_CARRIER_SATS } from "@crclaunch/cove-covenant";
import {
  buildTransferPsbtV2,
  broadcastValidatedCoveTransaction,
  validateFinalizedTransferTransaction,
  type ValidatedCoveTransaction,
} from "@crclaunch/cove-guardian/v3";
import { V3IndexerState } from "./state.js";
import { V3Store } from "./store.js";
import { hydrateState } from "./hydrate.js";
import { persistentWorker, reorgPersistentToTip } from "./persistent.js";
import { getTokenUtxosByScriptDb } from "./read-models-db.js";
import {
  REGTEST_KEYS,
  REGTEST_MINER_FEE,
  regtestConfig,
} from "./testing/regtest-fixture.js";
bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);
const RPC_URL = process.env.COVE_REGTEST_RPC_URL ?? "http://127.0.0.1:18443";
const RPC_USER = process.env.COVE_REGTEST_RPC_USER ?? "user";
const RPC_PASSWORD = process.env.COVE_REGTEST_RPC_PASSWORD ?? "pass";
const DB_URL = process.env.COVE_DATABASE_URL ?? process.env.DATABASE_URL;
function p2wpkh(key: { publicKey: Uint8Array }): Buffer {
  return bitcoin.payments.p2wpkh({
    pubkey: key.publicKey as Buffer,
    network: bitcoin.networks.regtest,
  }).output!;
}
function p2wpkhAddr(key: { publicKey: Uint8Array }): string {
  return bitcoin.payments.p2wpkh({
    pubkey: key.publicKey as Buffer,
    network: bitcoin.networks.regtest,
  }).address!;
}
class Rpc {
  private id = 0;
  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    headers.authorization = `Basic ${Buffer.from(`${RPC_USER}:${RPC_PASSWORD}`).toString("base64")}`;
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "1.0",
        id: `${++this.id}`,
        method,
        params,
      }),
      signal: AbortSignal.timeout(30000),
    });
    const json = (await res.json()) as {
      result?: T;
      error?: {
        message?: string;
      };
    };
    if (!res.ok || json.error)
      throw new Error(`RPC ${method}: ${json.error?.message ?? "err"}`);
    return json.result as T;
  }
  getNewAddress = () => this.call<string>("getnewaddress");
  createWallet = async (n: string) => {
    try {
      await this.call("createwallet", [
        n,
        false,
        false,
        "",
        false,
        false,
        false,
      ]);
    } catch (e) {
      if (!/already exists/i.test((e as Error).message)) throw e;
      await this.call("loadwallet", [n]).catch((le: Error) => {
        if (!/already loaded/i.test(le.message)) throw le;
      });
    }
  };
  sendToAddress = (a: string, btc: number) =>
    this.call<string>("sendtoaddress", [a, btc]);
  generate = (n: number, a: string) =>
    this.call<string[]>("generatetoaddress", [n, a]);
  getBestBlockHash = () => this.call<string>("getbestblockhash");
  invalidateBlock = (h: string) => this.call<void>("invalidateblock", [h]);
}
function orThrow(
  r:
    | ValidatedCoveTransaction
    | {
        ok: false;
        reason: string;
      },
): ValidatedCoveTransaction {
  if ("ok" in r) throw new Error(`final validation failed: ${r.reason}`);
  return r;
}
async function main() {
  if (!DB_URL) throw new Error("COVE_DATABASE_URL required (no skip)");
  const rpc = new Rpc();
  const provider = new CoreRpcProvider({
    url: RPC_URL,
    user: RPC_USER,
    password: RPC_PASSWORD,
  });
  const db = createDb(DB_URL);
  const cfg = regtestConfig();
  const store = new V3Store("regtest");
  await rpc.createWallet("cove53");
  const mineAddr = await rpc.getNewAddress();
  let state = await hydrateState(db, "regtest", cfg);
  const tokenIdHex = [...state.tokens.keys()][0]!;
  const tokenId = Buffer.from(tokenIdHex, "hex");
  const sync = async () => {
    await persistentWorker({ db, store, state, provider, config: cfg });
  };
  const mine = async () => {
    await rpc.generate(1, mineAddr);
    await sync();
  };
  const broadcast = async (v: ValidatedCoveTransaction) =>
    (
      await broadcastValidatedCoveTransaction({
        validated: v,
        network: "regtest",
        provider,
      })
    ).txid;
  const fund = async (
    key: {
      publicKey: Uint8Array;
    },
    btc: number,
  ) => {
    const txid = await rpc.sendToAddress(p2wpkhAddr(key), btc);
    await mine();
    const t = bitcoin.Transaction.fromHex(
      await provider.getRawTransaction(txid),
    );
    const script = p2wpkh(key);
    const vout = t.outs.findIndex((o) => o.script.equals(script));
    return { txid, vout, script, valueSats: BigInt(t.outs[vout]!.value) };
  };
  const alice = REGTEST_KEYS.alice,
    bob = REGTEST_KEYS.bob;
  const aliceScript = p2wpkh(alice).toString("hex");
  const bobScript = p2wpkh(bob).toString("hex");
  const aliceInv0 = await getTokenUtxosByScriptDb(db, "regtest", aliceScript);
  if (aliceInv0.length !== 1)
    throw new Error(`expected 1 Alice utxo, got ${aliceInv0.length}`);
  const sellerX = aliceInv0[0]!;
  const rootAfter = state.stateRoot();
  const amountAtoms = sellerX.amountAtoms;
  const transfer = buildTransferPsbtV2({
    network: bitcoin.networks.regtest,
    tokenId,
    tokenInputs: [
      {
        txid: sellerX.txid,
        vout: sellerX.vout,
        script: p2wpkh(alice),
        valueSats: TOKEN_CARRIER_SATS,
      },
    ],
    tokenInputTotalAtoms: amountAtoms,
    tokenOutputs: [{ script: p2wpkh(bob), amountAtoms }],
    funderInputs: [await fund(alice, 0.01)],
    funderChangeScript: p2wpkh(alice),
    btcOutputs: [],
    minerFeeSats: REGTEST_MINER_FEE,
  });
  transfer.psbt.signInput(0, alice);
  transfer.psbt.signInput(1, alice);
  transfer.psbt.finalizeAllInputs();
  const bobTransferTxid = await broadcast(
    orThrow(
      validateFinalizedTransferTransaction({
        rawTxHex: transfer.psbt.extractTransaction().toHex(),
        view: state,
      }),
    ),
  );
  await mine();
  const tipA = await rpc.getBestBlockHash();
  await rpc.invalidateBlock(tipA);
  await reorgPersistentToTip({ db, store, state, provider, config: cfg });
  {
    const h = await hydrateState(db, "regtest", cfg);
    if (
      (await getTokenUtxosByScriptDb(db, "regtest", aliceScript)).length !== 1
    )
      throw new Error("TRANSFER reorg: Alice inventory not restored");
    if ((await getTokenUtxosByScriptDb(db, "regtest", bobScript)).length !== 0)
      throw new Error("TRANSFER reorg: Bob inventory not removed");
    if (h.stateRoot() !== rootAfter)
      throw new Error(
        `TRANSFER reorg root mismatch ${h.stateRoot()} != ${rootAfter}`,
      );
  }
  console.log(`✓ TRANSFER reorg rollback (Alice restored, Bob removed)`);
  await rpc.generate(1, await rpc.getNewAddress());
  await sync();
  {
    const h = await hydrateState(db, "regtest", cfg);
    const spent = await db
      .select()
      .from(schema.coveV3TokenUtxos)
      .where(
        and(
          eq(schema.coveV3TokenUtxos.network, "regtest"),
          eq(schema.coveV3TokenUtxos.txid, sellerX.txid),
          eq(schema.coveV3TokenUtxos.vout, sellerX.vout),
        ),
      );
    if (spent[0]!.spentByTxid !== bobTransferTxid)
      throw new Error("replay spentByTxid wrong");
    if ((await getTokenUtxosByScriptDb(db, "regtest", bobScript)).length !== 1)
      throw new Error("Bob missing after replay");
    if (
      (await getTokenUtxosByScriptDb(db, "regtest", aliceScript)).length !== 0
    )
      throw new Error("Alice still owns after replay");
    void h;
  }
  console.log(
    `✓ replay (Bob re-confirmed; X.spentByTxid == ${bobTransferTxid.slice(0, 16)}…)`,
  );
  state = await hydrateState(db, "regtest", cfg);
  await sync();
  const finalRoot = (await hydrateState(db, "regtest", cfg)).stateRoot();
  const clean = new V3IndexerState(cfg);
  for (let h = 1n; h <= state.cursor.height; h++) {
    const hash = await provider.getBlockHash(Number(h));
    const blk = await provider.getBlock(hash);
    clean.applyBlock({
      height: h,
      hash: blk.hash,
      parentHash: blk.previousBlockHash,
      txs: blk.rawTxs,
    });
  }
  if (finalRoot !== clean.stateRoot())
    throw new Error(
      `final DB root ${finalRoot} != clean replay ${clean.stateRoot()}`,
    );
  console.log(`✓ restart + hydrate: DB root == clean replay root ${finalRoot}`);
  console.log("PERSISTENT REORG MATRIX PASSED");
}
main().catch((e) => {
  console.error(
    "persistent-reorg-matrix failed:",
    e instanceof Error ? (e.stack ?? e.message) : String(e),
  );
  process.exit(1);
});
