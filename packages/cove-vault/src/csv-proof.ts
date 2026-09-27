import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";
import { CoreRpcProvider } from "@crclaunch/bitcoin";
import { buildCoveVault } from "./vault.js";
import { policyIdentityHash } from "./policyIdentity.js";
import { RECOVERY_CSV_BLOCKS } from "./leaves.js";
bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);
const ECPair = ECPairFactory(ecc);
const RPC_URL = process.env.COVE_REGTEST_RPC_URL ?? "http://127.0.0.1:18443";
const RPC_USER = process.env.COVE_REGTEST_RPC_USER ?? "user";
const RPC_PASSWORD = process.env.COVE_REGTEST_RPC_PASSWORD ?? "pass";
const guardianXOnly = Buffer.from(
  ecc.pointFromScalar(Buffer.alloc(32, 0x42), true)!.subarray(1),
);
const ownerKey = ECPair.fromPrivateKey(Buffer.alloc(32, 0x43), {
  network: bitcoin.networks.regtest,
});
const ownerXOnly = Buffer.from(ownerKey.publicKey.subarray(1));
const S0_HASH = Buffer.from(
  "e27d7047a2a2f05a3f7ac319e12207c11487b59dcb212402785c129b85c518e2",
  "hex",
);
const CMR = Buffer.from(
  "7fb27adf2db5458882daf976ba9325815f111b2f3b16eedb72e75f96de4269b2",
  "hex",
);
const POLICY_IDENTITY = policyIdentityHash({
  version: 3,
  operation: 3,
  tokenId: "ab".repeat(32),
  currentStateHash: S0_HASH,
  cmr: CMR,
});
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}
function scriptWitness(items: Buffer[]): Buffer {
  const varInt = (n: number): Buffer => {
    if (n < 0xfd) return Buffer.from([n]);
    if (n <= 0xffff) {
      const b = Buffer.alloc(3);
      b[0] = 0xfd;
      b.writeUInt16LE(n, 1);
      return b;
    }
    const b = Buffer.alloc(5);
    b[0] = 0xfe;
    b.writeUInt32LE(n, 1);
    return b;
  };
  const parts: Buffer[] = [varInt(items.length)];
  for (const it of items) parts.push(varInt(it.length), it);
  return Buffer.concat(parts);
}
class RegtestRpc {
  private id = 0;
  constructor(
    private readonly url: string,
    private readonly user: string,
    private readonly password: string,
  ) {}
  private wallet = "";
  async call<T>(
    method: string,
    params: unknown[] = [],
    wallet = false,
  ): Promise<T> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    headers.authorization = `Basic ${Buffer.from(`${this.user}:${this.password}`).toString("base64")}`;
    const target =
      wallet && this.wallet ? `${this.url}/wallet/${this.wallet}` : this.url;
    const res = await fetch(target, {
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
    this.wallet = name;
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
    return this.call<string>("getnewaddress", [], true);
  }
  async sendToAddress(address: string, amountBtc: number): Promise<string> {
    return this.call<string>("sendtoaddress", [address, amountBtc], true);
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
function buildRecoveryPsbt(params: {
  vault: ReturnType<typeof buildCoveVault>;
  txid: string;
  vout: number;
  value: number;
  destScript: Buffer;
  feeSats: number;
  sequence: number;
}) {
  const { vault, txid, vout, value, destScript, feeSats, sequence } = params;
  const psbt = new bitcoin.Psbt({ network: bitcoin.networks.regtest });
  psbt.addInput({
    hash: txid,
    index: vout,
    witnessUtxo: { script: vault.scriptPubKey, value },
    tapInternalKey: vault.numsKey,
    tapLeafScript: [
      {
        leafVersion: 0xc0,
        script: vault.recoveryLeaf.script,
        controlBlock: vault.recoveryControlBlock,
      },
    ],
    sequence,
  });
  psbt.addOutput({ script: destScript, value: value - feeSats });
  return psbt;
}
async function main(): Promise<void> {
  const line = "─".repeat(72);
  const rpc = new RegtestRpc(RPC_URL, RPC_USER, RPC_PASSWORD);
  const info = await rpc.getBlockchainInfo();
  assert(info.chain === "regtest", `chain is ${info.chain}, expected regtest`);
  const provider = new CoreRpcProvider({
    url: RPC_URL,
    user: RPC_USER,
    password: RPC_PASSWORD,
  });
  const vault = buildCoveVault({
    policyIdentityHash: POLICY_IDENTITY,
    guardianXOnly,
    ownerXOnly,
  });
  console.log(line);
  console.log("COVE NUMS/DUAL-LEAF VAULT — 144-BLOCK CSV RECOVERY PROOF");
  console.log(line);
  console.log(`  NUMS internal key : ${vault.numsKey.toString("hex")}`);
  console.log(`  output key Q      : ${vault.outputKey.toString("hex")}`);
  console.log(`  vault address     : ${vault.address}`);
  console.log(`  merkle root       : ${vault.merkleRoot.toString("hex")}`);
  await rpc.createWallet("covevault");
  const walletAddress = await rpc.getNewAddress();
  await rpc.generateToAddress(101, walletAddress);
  const vaultAddress = bitcoin.address.fromOutputScript(
    vault.scriptPubKey,
    bitcoin.networks.regtest,
  );
  const fundTxid = await rpc.sendToAddress(vaultAddress, 0.001);
  await rpc.generateToAddress(1, walletAddress);
  const raw = await provider.getRawTransaction(fundTxid);
  const fundTx = bitcoin.Transaction.fromHex(raw);
  const vaultVout = findOutputIndex(fundTx, vault.scriptPubKey);
  assert(vaultVout >= 0, "vault output not found in funding tx");
  const vaultValue = fundTx.outs[vaultVout]!.value;
  const vaultConfHeight = (await rpc.getBlockchainInfo()).blocks;
  console.log(
    `\n✓ vault funded ${fundTxid}:${vaultVout} value=${vaultValue} (confirmed at height ${vaultConfHeight})`,
  );
  const destScript = bitcoin.address.toOutputScript(
    walletAddress,
    bitcoin.networks.regtest,
  );
  {
    const psbt = buildRecoveryPsbt({
      vault,
      txid: fundTxid,
      vout: vaultVout,
      value: vaultValue,
      destScript,
      feeSats: 1000,
      sequence: RECOVERY_CSV_BLOCKS,
    });
    psbt.signTaprootInput(0, ownerKey, vault.recoveryLeaf.tapleafHash);
    const sig = psbt.data.inputs[0]!.tapScriptSig![0]!.signature!;
    psbt.updateInput(0, {
      finalScriptWitness: scriptWitness([
        Buffer.from(sig),
        Buffer.alloc(0),
        vault.recoveryLeaf.script,
        vault.recoveryControlBlock,
      ]),
    });
    const hex = psbt.extractTransaction().toHex();
    const accept = await provider.testMempoolAccept(hex);
    console.log(
      `  premature spend  : allowed=${accept.allowed}${accept.rejectReason ? " reject=" + accept.rejectReason : ""}`,
    );
    assert(accept.allowed === false, "premature recovery must be REJECTED");
  }
  const target = vaultConfHeight + RECOVERY_CSV_BLOCKS - 1;
  const now = (await rpc.getBlockchainInfo()).blocks;
  await rpc.generateToAddress(target - now, walletAddress);
  console.log(
    `✓ mined to tip ${target} (vault is ${RECOVERY_CSV_BLOCKS} blocks deep)`,
  );
  {
    const psbt = buildRecoveryPsbt({
      vault,
      txid: fundTxid,
      vout: vaultVout,
      value: vaultValue,
      destScript,
      feeSats: 1000,
      sequence: RECOVERY_CSV_BLOCKS - 1,
    });
    psbt.signTaprootInput(0, ownerKey, vault.recoveryLeaf.tapleafHash);
    const sig = psbt.data.inputs[0]!.tapScriptSig![0]!.signature!;
    psbt.updateInput(0, {
      finalScriptWitness: scriptWitness([
        Buffer.from(sig),
        Buffer.alloc(0),
        vault.recoveryLeaf.script,
        vault.recoveryControlBlock,
      ]),
    });
    const accept = await provider.testMempoolAccept(
      psbt.extractTransaction().toHex(),
    );
    console.log(
      `  delay−1 (seq=143): allowed=${accept.allowed}${accept.rejectReason ? " reject=" + accept.rejectReason : ""}`,
    );
    assert(
      accept.allowed === false,
      "delay−1 (nSequence=143) must be REJECTED",
    );
  }
  const maturePsbt = buildRecoveryPsbt({
    vault,
    txid: fundTxid,
    vout: vaultVout,
    value: vaultValue,
    destScript,
    feeSats: 1000,
    sequence: RECOVERY_CSV_BLOCKS,
  });
  maturePsbt.signTaprootInput(0, ownerKey, vault.recoveryLeaf.tapleafHash);
  const sig = maturePsbt.data.inputs[0]!.tapScriptSig![0]!.signature!;
  maturePsbt.updateInput(0, {
    finalScriptWitness: scriptWitness([
      Buffer.from(sig),
      Buffer.alloc(0),
      vault.recoveryLeaf.script,
      vault.recoveryControlBlock,
    ]),
  });
  const matureHex = maturePsbt.extractTransaction().toHex();
  const matureAccept = await provider.testMempoolAccept(matureHex);
  console.log(
    `  delay (seq=144)  : allowed=${matureAccept.allowed}${matureAccept.rejectReason ? " reject=" + matureAccept.rejectReason : ""}`,
  );
  assert(
    matureAccept.allowed === true,
    `mature recovery must be ACCEPTED: ${matureAccept.rejectReason}`,
  );
  const spendTxid = await provider.broadcastTransaction(matureHex);
  await rpc.generateToAddress(1, walletAddress);
  console.log(`✓ recovery spend mined ${spendTxid}`);
  const spendRaw = await provider.getRawTransaction(spendTxid);
  const spendTx = bitcoin.Transaction.fromHex(spendRaw);
  const witness = spendTx.ins[0]!.witness;
  const [wsig, wpad, wscript, wcontrol] = witness;
  assert(wsig!.length === 64, "recovery witness signature must be 64 bytes");
  assert(
    wscript!.equals(vault.recoveryLeaf.script),
    "revealed script != committed recovery tapscript",
  );
  assert(
    wcontrol!.equals(vault.recoveryControlBlock),
    "control block != committed recovery control block",
  );
  assert(wpad!.length === 0, "OP_2DROP padding item must be empty");
  console.log(`    revealed recovery tapscript : ${wscript!.toString("hex")}`);
  console.log(`    control block               : ${wcontrol!.toString("hex")}`);
  console.log(
    `    signature (64B)             : ${wsig!.toString("hex").slice(0, 32)}…`,
  );
  console.log(
    `    witness stack size          : ${witness.length} (sig, pad, script, control block)`,
  );
  console.log("\n" + line);
  console.log(
    "CSV PROOF PASSED: premature REJECT, delay−1 REJECT, delay ACCEPT, recovery script-path spend verified",
  );
  console.log(`  vault txid   : ${fundTxid}`);
  console.log(`  spend txid   : ${spendTxid}`);
}
import { pathToFileURL } from "node:url";
const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => {
    console.error(
      "csv-proof failed:",
      e instanceof Error ? e.message : String(e),
    );
    process.exit(1);
  });
}
