import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory, type ECPairInterface } from "ecpair";
import { isKnownTestPrivateKeyHex } from "@crclaunch/cove-mainnet";
import {
  type GuardianV3Signer,
  computeVaultExecutionSighash,
  verifyVaultExecutionSignature,
  commitVaultExecutionWitness,
  type VaultLeafRef,
} from "./signer.js";
bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);
export interface GuardianCustodyBackend {
  xOnlyPubkey(): Promise<Buffer>;
  signTaprootScriptPath(params: {
    sighash: Buffer;
    leafTapleafHash: Buffer;
  }): Promise<Buffer>;
}
export class TestGuardianCustodyBackend implements GuardianCustodyBackend {
  private readonly key: ECPairInterface;
  private readonly xOnly: Buffer;
  constructor(priv: Buffer) {
    const ECPair = ECPairFactory(ecc);
    this.key = ECPair.fromPrivateKey(priv);
    this.xOnly = Buffer.from(this.key.publicKey.subarray(1));
  }
  async xOnlyPubkey(): Promise<Buffer> {
    return Buffer.from(this.xOnly);
  }
  async signTaprootScriptPath(params: {
    sighash: Buffer;
    leafTapleafHash: Buffer;
  }): Promise<Buffer> {
    return Buffer.from(ecc.signSchnorr(params.sighash, this.key.privateKey!));
  }
}
export class EnvGuardianCustodyBackend implements GuardianCustodyBackend {
  readonly #key: ECPairInterface;
  readonly #xOnly: Buffer;
  private constructor(priv: Buffer) {
    const ECPair = ECPairFactory(ecc);
    this.#key = ECPair.fromPrivateKey(priv);
    this.#xOnly = Buffer.from(this.#key.publicKey.subarray(1));
  }
  static fromHex(hex: string | undefined): EnvGuardianCustodyBackend {
    const h = (hex ?? "").trim();
    if (!/^[0-9a-fA-F]{64}$/.test(h))
      throw new Error("GUARDIAN_KEY_HEX must be exactly 64 hex characters");
    if (isKnownTestPrivateKeyHex(h))
      throw new Error(
        "GUARDIAN_KEY_HEX is one of the repo's public test keys; generate a real key",
      );
    const priv = Buffer.from(h, "hex");
    if (!ecc.isPrivate(priv))
      throw new Error("GUARDIAN_KEY_HEX is not a valid secp256k1 private key");
    return new EnvGuardianCustodyBackend(priv);
  }
  async xOnlyPubkey(): Promise<Buffer> {
    return Buffer.from(this.#xOnly);
  }
  async signTaprootScriptPath(params: {
    sighash: Buffer;
    leafTapleafHash: Buffer;
  }): Promise<Buffer> {
    return Buffer.from(ecc.signSchnorr(params.sighash, this.#key.privateKey!));
  }
  toJSON(): string {
    return "[EnvGuardianCustodyBackend]";
  }
}
export class UnconfiguredGuardianCustodyBackend implements GuardianCustodyBackend {
  async xOnlyPubkey(): Promise<Buffer> {
    throw new Error(
      "CUSTODY_BACKEND_NOT_CONFIGURED: no production custody backend selected",
    );
  }
  async signTaprootScriptPath(_params: {
    sighash: Buffer;
    leafTapleafHash: Buffer;
  }): Promise<Buffer> {
    throw new Error(
      "CUSTODY_BACKEND_NOT_CONFIGURED: no production custody backend selected",
    );
  }
}
export async function signVaultExecutionLeafWithCustody(
  psbt: bitcoin.Psbt,
  inputIndex: number,
  leaf: VaultLeafRef,
  controlBlock: Buffer,
  backend: GuardianCustodyBackend,
): Promise<Buffer> {
  const sighash = computeVaultExecutionSighash(psbt, inputIndex, leaf);
  const sig = await backend.signTaprootScriptPath({
    sighash,
    leafTapleafHash: leaf.tapleafHash,
  });
  const xOnly = await backend.xOnlyPubkey();
  verifyVaultExecutionSignature(psbt, inputIndex, leaf, sig, xOnly);
  commitVaultExecutionWitness(psbt, inputIndex, leaf, controlBlock, sig);
  return sig;
}
export interface GuardianSigningBackend {
  xOnlyPubkey(): Promise<Buffer>;
  signVaultExecutionLeaf(
    psbt: bitcoin.Psbt,
    inputIndex: number,
    leaf: VaultLeafRef,
    controlBlock: Buffer,
  ): Promise<Buffer>;
}
export function localSigningBackend(
  signer: GuardianV3Signer,
): GuardianSigningBackend {
  return {
    xOnlyPubkey: async () => signer.xOnlyPubkey(),
    signVaultExecutionLeaf: async (psbt, inputIndex, leaf, controlBlock) =>
      signer.signVaultExecutionLeaf(psbt, inputIndex, leaf, controlBlock),
  };
}
export function custodySigningBackend(
  backend: GuardianCustodyBackend,
): GuardianSigningBackend {
  return {
    xOnlyPubkey: () => backend.xOnlyPubkey(),
    signVaultExecutionLeaf: (psbt, inputIndex, leaf, controlBlock) =>
      signVaultExecutionLeafWithCustody(
        psbt,
        inputIndex,
        leaf,
        controlBlock,
        backend,
      ),
  };
}
