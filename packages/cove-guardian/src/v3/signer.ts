import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory, type ECPairInterface } from "ecpair";
import { unsignedTransaction } from "./resolve.js";
bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);
export interface VaultLeafRef {
  script: Buffer;
  tapleafHash: Buffer;
}
export function scriptWitness(items: Buffer[]): Buffer {
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
export function computeVaultExecutionSighash(
  psbt: bitcoin.Psbt,
  inputIndex: number,
  leaf: VaultLeafRef,
): Buffer {
  const tx = unsignedTransaction(psbt);
  const prevOutScripts = psbt.data.inputs.map((i) =>
    Buffer.from(i.witnessUtxo!.script),
  );
  const values = psbt.data.inputs.map((i) => i.witnessUtxo!.value);
  return tx.hashForWitnessV1(
    inputIndex,
    prevOutScripts,
    values,
    0x00,
    leaf.tapleafHash,
  );
}
export function verifyVaultExecutionSignature(
  psbt: bitcoin.Psbt,
  inputIndex: number,
  leaf: VaultLeafRef,
  sig: Buffer,
  xOnly: Buffer,
): void {
  const tx = unsignedTransaction(psbt);
  let sig64 = sig;
  let hashType = 0x00;
  if (sig.length === 65) {
    sig64 = sig.subarray(0, 64);
    hashType = sig[sig.length - 1]!;
  }
  const prevOutScripts = psbt.data.inputs.map((i) =>
    Buffer.from(i.witnessUtxo!.script),
  );
  const values = psbt.data.inputs.map((i) => i.witnessUtxo!.value);
  const sighash = tx.hashForWitnessV1(
    inputIndex,
    prevOutScripts,
    values,
    hashType,
    leaf.tapleafHash,
  );
  if (!ecc.verifySchnorr(sighash, xOnly, sig64)) {
    throw new Error(
      "SCHNORR_VERIFY_FAILED: signature failed independent verification",
    );
  }
}
export function commitVaultExecutionWitness(
  psbt: bitcoin.Psbt,
  inputIndex: number,
  leaf: VaultLeafRef,
  controlBlock: Buffer,
  sig: Buffer,
): Buffer {
  const reveal = leaf.script.subarray(1, 33);
  psbt.updateInput(inputIndex, {
    finalScriptWitness: scriptWitness([sig, reveal, leaf.script, controlBlock]),
  });
  return sig;
}
export class GuardianV3Signer {
  private constructor(
    private readonly key: ECPairInterface,
    private readonly xOnly: Buffer,
  ) {}
  static fromPrivateKey(priv: Buffer): GuardianV3Signer {
    const ECPair = ECPairFactory(ecc);
    const key = ECPair.fromPrivateKey(priv);
    const xOnly = Buffer.from(key.publicKey.subarray(1));
    return new GuardianV3Signer(key, xOnly);
  }
  xOnlyPubkey(): Buffer {
    return Buffer.from(this.xOnly);
  }
  signVaultExecutionLeaf(
    psbt: bitcoin.Psbt,
    inputIndex: number,
    leaf: VaultLeafRef,
    controlBlock: Buffer,
  ): Buffer {
    psbt.signTaprootInput(inputIndex, this.key, leaf.tapleafHash);
    const sigFull = psbt.data.inputs[inputIndex]!.tapScriptSig![0]!.signature!;
    const sig = Buffer.from(sigFull);
    verifyVaultExecutionSignature(psbt, inputIndex, leaf, sig, this.xOnly);
    commitVaultExecutionWitness(psbt, inputIndex, leaf, controlBlock, sig);
    return sig;
  }
}
