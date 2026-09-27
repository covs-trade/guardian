import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory, type ECPairInterface } from "ecpair";
import { CHAIN_BITCOIN_REGTEST, computeTokenId } from "@crclaunch/cove-wire";
import type { V3IndexerConfig } from "../types.js";
bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);
const ECPair = ECPairFactory(ecc);
const p2wpkh = (key: ECPairInterface): Buffer =>
  bitcoin.payments.p2wpkh({
    pubkey: key.publicKey,
    network: bitcoin.networks.regtest,
  }).output!;
const p2wpkhAddr = (key: ECPairInterface): string =>
  bitcoin.payments.p2wpkh({
    pubkey: key.publicKey,
    network: bitcoin.networks.regtest,
  }).address!;
export const REGTEST_GUARDIAN_PRIV = Buffer.alloc(32, 0x42);
export const REGTEST_RECOVERY_PRIV = Buffer.alloc(32, 0x43);
export const REGTEST_FEE_PRIV = Buffer.alloc(32, 0x44);
export const REGTEST_DEPLOYER_PRIV = Buffer.alloc(32, 0x45);
export const REGTEST_ALICE_PRIV = Buffer.alloc(32, 0x46);
export const REGTEST_BOB_PRIV = Buffer.alloc(32, 0x47);
export const REGTEST_CAROL_PRIV = Buffer.alloc(32, 0x48);
export const REGTEST_P2P_BUYER_PRIV = Buffer.alloc(32, 0x49);
export const REGTEST_NONCE = Buffer.alloc(32, 0xab);
export const REGTEST_TICKER = "FROG";
export const REGTEST_CHAIN_IDENTITY = CHAIN_BITCOIN_REGTEST;
export const REGTEST_MINER_FEE = 1000n;
function key(priv: Buffer): ECPairInterface {
  return ECPair.fromPrivateKey(priv, { network: bitcoin.networks.regtest });
}
export const REGTEST_KEYS = {
  guardian: key(REGTEST_GUARDIAN_PRIV),
  recovery: key(REGTEST_RECOVERY_PRIV),
  fee: key(REGTEST_FEE_PRIV),
  deployer: key(REGTEST_DEPLOYER_PRIV),
  alice: key(REGTEST_ALICE_PRIV),
  bob: key(REGTEST_BOB_PRIV),
  carol: key(REGTEST_CAROL_PRIV),
  p2pBuyer: key(REGTEST_P2P_BUYER_PRIV),
} as const;
export const REGTEST_GUARDIAN_XONLY = Buffer.from(
  REGTEST_KEYS.guardian.publicKey.subarray(1),
);
export const REGTEST_RECOVERY_XONLY = Buffer.from(
  REGTEST_KEYS.recovery.publicKey.subarray(1),
);
export const REGTEST_FEE_SCRIPT = p2wpkh(REGTEST_KEYS.fee);
export const REGTEST_FEE_ADDRESS = p2wpkhAddr(REGTEST_KEYS.fee);
export function regtestTokenId(creatorScript: Buffer): Buffer {
  return computeTokenId({
    chainIdentity: REGTEST_CHAIN_IDENTITY,
    policyVersion: 3,
    ticker: REGTEST_TICKER,
    tokenNonce: REGTEST_NONCE,
    creatorScript,
  });
}
export function regtestConfig(): V3IndexerConfig {
  return {
    network: "regtest",
    chainIdentity: REGTEST_CHAIN_IDENTITY,
    guardianXOnly: REGTEST_GUARDIAN_XONLY,
    recoveryKeyXOnly: REGTEST_RECOVERY_XONLY,
    feeScript: REGTEST_FEE_SCRIPT,
    genesisHeight: 0n,
  };
}
