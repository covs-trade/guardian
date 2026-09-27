import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";
import {
  deriveStateOutput,
  stateHash,
  stateOutputScript,
  type CoveState,
} from "@crclaunch/cove-covenant";
import { CoreRpcProvider } from "@crclaunch/bitcoin";
import { TaprootGuardianSigner } from "./signer.js";
import { RESERVE_ANCHOR_SATS, buildMintPsbt, type MintIntent } from "./tx.js";
bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);
const ECPair = ECPairFactory(ecc);
const WIF = "cPoVxi18CnxHUQjYNpjRM3RYUVFA61wuTNQez7BtRKkfp9Fw6RTW";
const internalKey = Buffer.from(
  ecc.pointFromScalar(Buffer.alloc(32, 0x42), true)!.subarray(1),
);
const MINT_42M = 50000n * 100000000n;
const MINT_84M = 500000n * 100000000n;
const S0: CoveState = {
  version: 1,
  tokenId: "ab".repeat(32),
  phase: "PUBLIC_MINT",
  publicSupplyAtoms: 0n,
  reserveSats: 0n,
  curveStage: 1,
};
const RECIPIENT = Buffer.from("5120" + "cc".repeat(32), "hex");
const PLATFORM_FEE = Buffer.from("0014" + "dd".repeat(20), "hex");
const BUYER_CHANGE = Buffer.from("0014" + "ee".repeat(20), "hex");
const MINER_FEE = 1000n;
const BUYER_FUND = 2000000n;
const RPC_URL = process.env.COVE_REGTEST_RPC_URL ?? "http://127.0.0.1:18443";
const RPC_USER = process.env.COVE_REGTEST_RPC_USER ?? "user";
const RPC_PASSWORD = process.env.COVE_REGTEST_RPC_PASSWORD ?? "pass";
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}
function intent(prev: CoveState = S0, amountAtoms = MINT_42M): MintIntent {
  return {
    prevState: prev,
    amountAtoms,
    recipientCommitment: RECIPIENT,
    platformFeeScript: PLATFORM_FEE,
  };
}
function mutateOutput(
  psbt: bitcoin.Psbt,
  index: number,
  patch: {
    script?: Buffer;
    value?: number;
  },
): void {
  const tx = (
    psbt as unknown as {
      __CACHE: {
        __TX: bitcoin.Transaction;
      };
    }
  ).__CACHE.__TX;
  if (patch.script) tx.outs[index]!.script = patch.script;
  if (patch.value !== undefined) tx.outs[index]!.value = patch.value;
}
function addOutput(psbt: bitcoin.Psbt, script: Buffer, value: number): void {
  const tx = (
    psbt as unknown as {
      __CACHE: {
        __TX: bitcoin.Transaction;
      };
    }
  ).__CACHE.__TX;
  tx.outs.push({ script, value });
}
function offlineProof(): void {
  const line = "─".repeat(72);
  console.log(line);
  console.log(
    "COVE COVENANT — POLICY BOUND TO THE ACTUAL BITCOIN SPEND",
  );
  console.log(line);
  const signer = new TaprootGuardianSigner(WIF, "regtest");
  console.log(
    `\nGuardian internal key P: ${signer.internalKey.toString("hex")}`,
  );
  console.log("\n[1] State encoding + hash");
  console.log(`    S0 hash: ${stateHash(S0)}`);
  console.log("\n[2] State-committed P2TR (S0 vs S1 differ)");
  const o0 = deriveStateOutput(internalKey, S0, bitcoin.networks.regtest);
  console.log(`    S0 output: ${o0.scriptPubKeyHex}`);
  console.log(`    S0 address: ${o0.address}`);
  console.log("\n[3] Canonical MINT transaction layout (buildMintPsbt)");
  const built = buildMintPsbt({
    internalKey,
    intent: intent(),
    stateInput: {
      txid: "a".repeat(64),
      vout: 0,
      script: stateOutputScript(S0, internalKey),
      valueSats: S0.reserveSats + RESERVE_ANCHOR_SATS,
    },
    buyerInputs: [
      {
        txid: "b".repeat(64),
        vout: 0,
        script: BUYER_CHANGE,
        valueSats: BUYER_FUND,
      },
    ],
    buyerChangeScript: BUYER_CHANGE,
    minerFeeSats: MINER_FEE,
    network: "regtest",
  });
  const a = built.analysis;
  console.log(`    curve contribution : ${a.curveContributionSats} sats`);
  console.log(`    platform fee       : ${a.platformFeeSats} sats`);
  console.log(`    miner fee          : ${a.minerFeeSats} sats`);
  console.log(`    buyer change       : ${a.buyerChangeSats} sats`);
  console.log(
    `    S1 supply          : ${a.nextState.publicSupplyAtoms} atoms`,
  );
  console.log(`    S1 reserve (locked): ${a.nextState.reserveSats} sats`);
  console.log(
    `    S1 output          : ${stateOutputScript(a.nextState, internalKey).toString("hex")}`,
  );
  console.log(
    "\n[4] Guardian validates the ACTUAL PSBT, then signs the BIP341 sighash",
  );
  const signed = signer.signMintTx(built.psbt, intent());
  const q0 = stateOutputScript(S0, internalKey).subarray(2);
  const sigOk = ecc.verifySchnorr(
    signed.sighash,
    q0,
    signed.tapKeySig.subarray(0, 64),
  );
  console.log(`    sighash            : ${signed.sighash.toString("hex")}`);
  console.log(
    `    tapKeySig (64B)    : ${signed.tapKeySig.toString("hex").slice(0, 32)}…`,
  );
  console.log(
    `    key-path sig verifies against Q(S0): ${sigOk ? "YES" : "NO"}`,
  );
  console.log(
    `    audit digest (P)   : ${signed.auditDigest.toString("hex").slice(0, 32)}… (NOT the UTXO auth)`,
  );
  console.log(
    `    audit sig verifies under P          : ${signer.verifyAuditSignature(signed.auditDigest, signed.auditSignature) ? "YES" : "NO"}`,
  );
  console.log("\n[5] Adversarial ACTUAL-PSBT mutations (Guardian must refuse)");
  const cases: [string, (p: bitcoin.Psbt) => void, string][] = [
    [
      "wrong successor script",
      (p) =>
        mutateOutput(p, 0, {
          script: Buffer.from("5120" + "ff".repeat(32), "hex"),
        }),
      "SUCCESSOR_SCRIPT_MISMATCH",
    ],
    [
      "wrong successor BTC value",
      (p) => mutateOutput(p, 0, { value: 31001 }),
      "RESERVE_CONTRIBUTION_MISMATCH",
    ],
    [
      "missing reserve contribution",
      (p) => mutateOutput(p, 0, { value: 30000 }),
      "RESERVE_CONTRIBUTION_MISMATCH",
    ],
    [
      "wrong recipient",
      (p) =>
        mutateOutput(p, 1, {
          script: Buffer.from("0014" + "11".repeat(20), "hex"),
        }),
      "RECIPIENT_OUTPUT_MISMATCH",
    ],
    ["wrong fee", (p) => mutateOutput(p, 3, { value: 1 }), "FEE_OUT_OF_RANGE"],
    [
      "extra unauthorized output",
      (p) => addOutput(p, Buffer.from("0014" + "22".repeat(20), "hex"), 5000),
      "EXTRA_UNAUTHORIZED_OUTPUT",
    ],
    [
      "wrong prevout",
      (p) => {
        p.data.inputs[0]!.witnessUtxo!.script = Buffer.from(
          "5120" + "ff".repeat(32),
          "hex",
        );
      },
      "STATE_INPUT_NOT_FOUND",
    ],
  ];
  for (const [label, mutate, reason] of cases) {
    const fresh = buildMintPsbt({
      internalKey,
      intent: intent(),
      stateInput: {
        txid: "a".repeat(64),
        vout: 0,
        script: stateOutputScript(S0, internalKey),
        valueSats: S0.reserveSats + RESERVE_ANCHOR_SATS,
      },
      buyerInputs: [
        {
          txid: "b".repeat(64),
          vout: 0,
          script: BUYER_CHANGE,
          valueSats: BUYER_FUND,
        },
      ],
      buyerChangeScript: BUYER_CHANGE,
      minerFeeSats: MINER_FEE,
      network: "regtest",
    });
    mutate(fresh.psbt);
    let refused = "NO";
    let got = "";
    try {
      signer.signMintTx(fresh.psbt, intent());
    } catch (e) {
      refused = "YES";
      got = (e as Error).message;
    }
    const ok = refused === "YES" && got === reason;
    console.log(
      `    ${label.padEnd(28)} refused=${refused} reason=${got} ${ok ? "✓" : "✗ EXPECTED " + reason}`,
    );
    assert(ok, `${label} should reject with ${reason}, got ${got}`);
  }
  console.log("\n" + line);
  console.log(
    "OFFLINE PROOF PASSED: policy is bound to the actual transaction; no WIF/tweaked-key path signs without validation.",
  );
}
class RegtestRpc {
  private id = 0;
  constructor(
    private readonly url: string,
    private readonly user: string,
    private readonly password: string,
  ) {}
  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    headers.authorization = `Basic ${Buffer.from(`${this.user}:${this.password}`).toString("base64")}`;
    const res = await fetch(this.url, {
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
    const text = await res.text();
    let json: {
      result?: T;
      error?: {
        message?: string;
      } | null;
    } = {};
    try {
      json = JSON.parse(text) as typeof json;
    } catch {
      json = {};
    }
    if (!res.ok || json.error) {
      throw new Error(
        `RPC ${method}: ${json.error?.message ?? text.slice(0, 200) ?? `HTTP ${res.status}`}`,
      );
    }
    return json.result as T;
  }
  async createWallet(name: string): Promise<void> {
    try {
      await this.call("createwallet", [
        name,
        false,
        false,
        "",
        false,
        true,
        false,
      ]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/already exists/i.test(msg)) throw e;
      await this.call("loadwallet", [name]).catch((le: Error) => {
        if (!/already loaded/i.test(le.message)) throw le;
      });
    }
  }
  async getNewAddress(): Promise<string> {
    return this.call<string>("getnewaddress");
  }
  async sendToAddress(address: string, amountBtc: number): Promise<string> {
    return this.call<string>("sendtoaddress", [address, amountBtc]);
  }
  async generateToAddress(n: number, address: string): Promise<string[]> {
    return this.call<string[]>("generatetoaddress", [n, address]);
  }
  async getBlockchainInfo(): Promise<{
    chain: string;
    blocks: number;
  }> {
    return this.call("getblockchaininfo");
  }
}
function findOutputIndex(tx: bitcoin.Transaction, script: Buffer): number {
  return tx.outs.findIndex((o) => o.script.equals(script));
}
async function realCoreProof(): Promise<void> {
  const line = "─".repeat(72);
  console.log("\n" + line);
  console.log("REAL BITCOIN CORE REGTEST PROOF (unmodified bitcoind)");
  console.log(line);
  const rpc = new RegtestRpc(RPC_URL, RPC_USER, RPC_PASSWORD);
  const info = await rpc.getBlockchainInfo();
  assert(info.chain === "regtest", `chain is ${info.chain}, expected regtest`);
  const provider = new CoreRpcProvider({
    url: RPC_URL,
    user: RPC_USER,
    password: RPC_PASSWORD,
  });
  const mintIntent = intent(S0, MINT_84M);
  await rpc.createWallet("cove15");
  const walletAddress = await rpc.getNewAddress();
  await rpc.generateToAddress(101, walletAddress);
  const buyerKey = ECPair.makeRandom({ network: bitcoin.networks.regtest });
  const buyerP2wpkh = bitcoin.payments.p2wpkh({
    pubkey: buyerKey.publicKey,
    network: bitcoin.networks.regtest,
  });
  const buyerAddress = buyerP2wpkh.address!;
  const buyerScript = buyerP2wpkh.output!;
  const buyerFundingTxid = await rpc.sendToAddress(buyerAddress, 1.0);
  await rpc.generateToAddress(1, walletAddress);
  const buyerRaw = await provider.getRawTransaction(buyerFundingTxid);
  const buyerTx = bitcoin.Transaction.fromHex(buyerRaw);
  const buyerVout = findOutputIndex(buyerTx, buyerScript);
  assert(buyerVout >= 0, "buyer output not found in funding tx");
  const buyerValue = BigInt(buyerTx.outs[buyerVout]!.value);
  console.log(
    `✓ buyer UTXO ${buyerFundingTxid}:${buyerVout} value=${buyerValue}`,
  );
  const s0Script = stateOutputScript(S0, internalKey);
  const s0Address = bitcoin.address.fromOutputScript(
    s0Script,
    bitcoin.networks.regtest,
  );
  const s0FundingTxid = await rpc.sendToAddress(
    s0Address,
    Number(RESERVE_ANCHOR_SATS) / 1e8,
  );
  await rpc.generateToAddress(1, walletAddress);
  const s0Raw = await provider.getRawTransaction(s0FundingTxid);
  const s0Tx = bitcoin.Transaction.fromHex(s0Raw);
  const s0Vout = findOutputIndex(s0Tx, s0Script);
  assert(s0Vout >= 0, "S0 output not found in funding tx");
  const s0Value = BigInt(s0Tx.outs[s0Vout]!.value);
  assert(
    s0Value === RESERVE_ANCHOR_SATS,
    `S0 value ${s0Value} != anchor ${RESERVE_ANCHOR_SATS}`,
  );
  console.log(
    `✓ S0 UTXO ${s0FundingTxid}:${s0Vout} value=${s0Value} script=${s0Script.toString("hex")}`,
  );
  const built = buildMintPsbt({
    internalKey,
    intent: mintIntent,
    stateInput: {
      txid: s0FundingTxid,
      vout: s0Vout,
      script: s0Script,
      valueSats: s0Value,
    },
    buyerInputs: [
      {
        txid: buyerFundingTxid,
        vout: buyerVout,
        script: buyerScript,
        valueSats: buyerValue,
      },
    ],
    buyerChangeScript: buyerScript,
    minerFeeSats: MINER_FEE,
    network: "regtest",
  });
  const a = built.analysis;
  console.log(
    `✓ MINT PSBT: curve=${a.curveContributionSats} platform=${a.platformFeeSats} fee=${a.minerFeeSats} change=${a.buyerChangeSats}`,
  );
  const signer = new TaprootGuardianSigner(WIF, "regtest");
  const signed = signer.signMintTx(built.psbt, mintIntent);
  const q0 = stateOutputScript(S0, internalKey).subarray(2);
  assert(
    ecc.verifySchnorr(signed.sighash, q0, signed.tapKeySig.subarray(0, 64)),
    "Guardian key-path sig must verify",
  );
  console.log(
    `✓ Guardian validated the real PSBT and signed the BIP341 sighash`,
  );
  const buyerInputIndex = built.psbt.data.inputs.findIndex(
    (_, i) => i !== a.stateInputIndex,
  );
  built.psbt.signInput(buyerInputIndex, buyerKey);
  built.psbt.finalizeAllInputs();
  const hex = built.psbt.extractTransaction().toHex();
  const accept = await provider.testMempoolAccept(hex);
  console.log(
    `✓ testmempoolaccept: allowed=${accept.allowed}${accept.rejectReason ? " reject=" + accept.rejectReason : ""}`,
  );
  assert(
    accept.allowed === true,
    `testmempoolaccept rejected: ${accept.rejectReason}`,
  );
  const mintTxid = await provider.broadcastTransaction(hex);
  await rpc.generateToAddress(1, walletAddress);
  console.log(`✓ MINT ${mintTxid} mined`);
  const raw = await provider.getRawTransaction(mintTxid);
  const tx = bitcoin.Transaction.fromHex(raw);
  const s1 = a.nextState;
  const expectedS1 = stateOutputScript(s1, internalKey).toString("hex");
  const successorOut = tx.outs[0]!.script.toString("hex");
  const successorValue = BigInt(tx.outs[0]!.value);
  const recipientOut = tx.outs[1]!.script.toString("hex");
  console.log(`    successor output : ${successorOut}`);
  console.log(
    `    successor value  : ${successorValue} sats (expected ${s1.reserveSats + RESERVE_ANCHOR_SATS})`,
  );
  console.log(`    recipient output : ${recipientOut}`);
  assert(
    successorOut === expectedS1,
    `successor ${successorOut} != Q(S1) ${expectedS1}`,
  );
  assert(
    successorValue === s1.reserveSats + RESERVE_ANCHOR_SATS,
    "successor value != reserve + anchor",
  );
  assert(
    recipientOut === RECIPIENT.toString("hex"),
    `recipient ${recipientOut} != intended ${RECIPIENT.toString("hex")}`,
  );
  console.log(
    `    reserve before   : ${S0.reserveSats} sats (UTXO ${s0Value})`,
  );
  console.log(
    `    reserve after    : ${s1.reserveSats} sats (UTXO ${successorValue}, anchor ${RESERVE_ANCHOR_SATS})`,
  );
  assert(
    s1.reserveSats === S0.reserveSats + a.curveContributionSats,
    "reserve did not increase by curve contribution",
  );
  console.log("\n    Adversarial mutations of the real PSBT:");
  const adversarial: [string, (p: bitcoin.Psbt) => void, string][] = [
    [
      "successor script",
      (p) =>
        mutateOutput(p, 0, {
          script: Buffer.from("5120" + "ff".repeat(32), "hex"),
        }),
      "SUCCESSOR_SCRIPT_MISMATCH",
    ],
    [
      "successor amount",
      (p) =>
        mutateOutput(p, 0, {
          value: Number(s1.reserveSats + RESERVE_ANCHOR_SATS) + 1,
        }),
      "RESERVE_CONTRIBUTION_MISMATCH",
    ],
    [
      "recipient",
      (p) =>
        mutateOutput(p, 1, {
          script: Buffer.from("0014" + "11".repeat(20), "hex"),
        }),
      "RECIPIENT_OUTPUT_MISMATCH",
    ],
    ["fee", (p) => mutateOutput(p, 3, { value: 1 }), "FEE_OUT_OF_RANGE"],
    [
      "extra output",
      (p) => addOutput(p, Buffer.from("0014" + "22".repeat(20), "hex"), 5000),
      "EXTRA_UNAUTHORIZED_OUTPUT",
    ],
  ];
  for (const [label, mutate, reason] of adversarial) {
    const fresh = buildMintPsbt({
      internalKey,
      intent: mintIntent,
      stateInput: {
        txid: s0FundingTxid,
        vout: s0Vout,
        script: s0Script,
        valueSats: s0Value,
      },
      buyerInputs: [
        {
          txid: buyerFundingTxid,
          vout: buyerVout,
          script: buyerScript,
          valueSats: buyerValue,
        },
      ],
      buyerChangeScript: buyerScript,
      minerFeeSats: MINER_FEE,
      network: "regtest",
    });
    mutate(fresh.psbt);
    let refused = false;
    let got = "";
    try {
      signer.signMintTx(fresh.psbt, mintIntent);
    } catch (e) {
      refused = true;
      got = (e as Error).message;
    }
    assert(
      refused && got === reason,
      `${label}: expected ${reason}, got ${got || "SIGNED"}`,
    );
    console.log(`      ${label.padEnd(20)} refused=YES reason=${got}`);
  }
  console.log("\nREAL CORE REGTEST PROOF PASSED");
  console.log(`    S0 txid       : ${s0FundingTxid}`);
  console.log(`    MINT txid     : ${mintTxid}`);
  console.log(`    mempoolaccept : allowed=true`);
}
async function main(): Promise<void> {
  offlineProof();
  try {
    const probe = new RegtestRpc(RPC_URL, RPC_USER, RPC_PASSWORD);
    await probe.getBlockchainInfo();
    await realCoreProof();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/fetch failed|ECONNREFUSED|ENOTFOUND|ECONNRESET/.test(msg)) {
      console.log(
        `\nSKIPPED real Core proof (bitcoind not reachable at ${RPC_URL})`,
      );
      return;
    }
    console.error("regtest-proof failed:", msg);
    process.exit(1);
  }
}
import { pathToFileURL } from "node:url";
const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => {
    console.error(
      "regtest-proof failed:",
      e instanceof Error ? e.message : String(e),
    );
    process.exit(1);
  });
}
