import * as bitcoin from "bitcoinjs-lib";
import { checkSpendSignature } from "@crclaunch/bitcoin";
import type { CoveVault } from "@crclaunch/cove-vault";
import type { GuardianCustodyBackend } from "./v3/custody.js";
import { commitVaultExecutionWitness, verifyVaultExecutionSignature } from "./v3/signer.js";

export async function signCrc20VaultInput(
  psbt: bitcoin.Psbt,
  vault: CoveVault,
  backend: GuardianCustodyBackend,
): Promise<Buffer> {
  const input = psbt.data.inputs[0];
  if (!input?.witnessUtxo?.script.equals(vault.scriptPubKey) ||
    !input.tapInternalKey?.equals(vault.numsKey) ||
    !input.tapMerkleRoot?.equals(vault.merkleRoot))
    throw new Error("CRC vault script or commitment mismatch");
  const leaf = input.tapLeafScript;
  if (leaf?.length !== 1 || leaf[0]!.leafVersion !== 0xc0 ||
    !leaf[0]!.script.equals(vault.executionLeaf.script) ||
    !leaf[0]!.controlBlock.equals(vault.executionControlBlock))
    throw new Error("CRC vault execution leaf mismatch");
  if (psbt.txInputs.length < 2)
    throw new Error("CRC vault transaction needs a signed trader input");
  const seen = new Set<string>();
  for (let index = 0; index < psbt.txInputs.length; index++) {
    const txIn = psbt.txInputs[index]!;
    const outpoint = `${Buffer.from(txIn.hash).reverse().toString("hex")}:${txIn.index}`;
    if (seen.has(outpoint)) throw new Error("duplicate CRC vault input");
    seen.add(outpoint);
    if (!psbt.data.inputs[index]?.witnessUtxo)
      throw new Error("CRC vault input has no prevout");
    if (index > 0) {
      const verdict = checkSpendSignature(psbt, index);
      if (!verdict.ok) throw new Error(`wallet signature invalid: ${verdict.detail}`);
    }
  }
  const guardianXOnly = await backend.xOnlyPubkey();
  const chunks = bitcoin.script.decompile(vault.executionLeaf.script);
  if (!chunks || chunks.length !== 4 || !Buffer.isBuffer(chunks[2]) ||
    !chunks[2].equals(guardianXOnly))
    throw new Error("CRC vault Guardian key mismatch");
  const unsigned = bitcoin.Transaction.fromBuffer(psbt.data.globalMap.unsignedTx.toBuffer());
  const hashType = bitcoin.Transaction.SIGHASH_ALL;
  const sighash = unsigned.hashForWitnessV1(
    0,
    psbt.data.inputs.map((item) => item.witnessUtxo!.script),
    psbt.data.inputs.map((item) => item.witnessUtxo!.value),
    hashType,
    vault.executionLeaf.tapleafHash,
  );
  const rawSignature = await backend.signTaprootScriptPath({
    sighash,
    leafTapleafHash: vault.executionLeaf.tapleafHash,
  });
  if (rawSignature.length !== 64) throw new Error("CRC Guardian returned invalid signature length");
  const signature = Buffer.concat([rawSignature, Buffer.from([hashType])]);
  verifyVaultExecutionSignature(psbt, 0, vault.executionLeaf, signature, guardianXOnly);
  commitVaultExecutionWitness(psbt, 0, vault.executionLeaf, vault.executionControlBlock, signature);
  return signature;
}
