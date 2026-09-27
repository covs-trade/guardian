import type { CoreRpcProvider } from "@crclaunch/bitcoin";
import * as bitcoin from "bitcoinjs-lib";
import { buildBackingVaultV3 } from "@crclaunch/cove-vault";
import { RESERVE_ANCHOR_SATS } from "./constants.js";
import { V3IndexerState } from "./state.js";
import type { V3IndexerConfig } from "./types.js";
export interface VerifyResult {
  ok: boolean;
  reason?: string;
}
export async function quickVerify(
  state: V3IndexerState,
  provider: CoreRpcProvider,
): Promise<VerifyResult> {
  if (state.cursor.height > 0n) {
    const coreHash = await provider.getBlockHash(Number(state.cursor.height));
    if (coreHash !== state.cursor.blockHash) {
      return {
        ok: false,
        reason: `cursor hash mismatch: db=${state.cursor.blockHash} core=${coreHash}`,
      };
    }
  }
  const btcNet =
    state.config.network === "regtest"
      ? bitcoin.networks.regtest
      : state.config.network === "mainnet"
        ? bitcoin.networks.bitcoin
        : bitcoin.networks.testnet;
  for (const b of state.backing.values()) {
    const prevout = await provider.getPrevout(b.outpoint.txid, b.outpoint.vout);
    if (!prevout) {
      return {
        ok: false,
        reason: `backing outpoint not unspent: ${b.outpoint.txid}:${b.outpoint.vout}`,
      };
    }
    if (prevout.valueSats !== b.btcValue) {
      return {
        ok: false,
        reason: `backing value mismatch for ${b.tokenId}: core=${prevout.valueSats} db=${b.btcValue}`,
      };
    }
    if (prevout.scriptPubKeyHex !== b.scriptPubKey) {
      return { ok: false, reason: `backing script mismatch for ${b.tokenId}` };
    }
    const vault = buildBackingVaultV3({
      state: b.state,
      guardianXOnly: state.config.guardianXOnly,
      recoveryKeyXOnly: state.config.recoveryKeyXOnly,
      network: btcNet,
    });
    if (vault.scriptPubKey.toString("hex") !== b.scriptPubKey) {
      return {
        ok: false,
        reason: `backing script != derived V3 vault for ${b.tokenId}`,
      };
    }
    if (b.btcValue !== RESERVE_ANCHOR_SATS + b.state.backingSats) {
      return {
        ok: false,
        reason: `backing value != anchor + R(supply) for ${b.tokenId}`,
      };
    }
  }
  if (
    state.cursor.height > 0n &&
    state.stateRoot() !== state.cursor.stateRoot
  ) {
    return {
      ok: false,
      reason: `db root ${state.stateRoot()} != cursor root ${state.cursor.stateRoot}`,
    };
  }
  const seen = new Set<string>();
  for (const u of state.tokenUtxos.values()) {
    if (u.amountAtoms <= 0n)
      return {
        ok: false,
        reason: `non-positive token amount ${u.txid}:${u.vout}`,
      };
    if (!state.tokens.has(u.tokenId))
      return { ok: false, reason: `utxo for unknown token ${u.tokenId}` };
    const key = `${u.txid}:${u.vout}`;
    if (seen.has(key))
      return { ok: false, reason: `duplicate outpoint ${key}` };
    seen.add(key);
  }
  return { ok: true };
}
export async function fullVerify(
  state: V3IndexerState,
  provider: CoreRpcProvider,
  config: V3IndexerConfig,
): Promise<VerifyResult> {
  if (state.cursor.height > 0n) {
    const coreHash = await provider.getBlockHash(Number(state.cursor.height));
    if (coreHash !== state.cursor.blockHash) {
      return {
        ok: false,
        reason: `cursor hash mismatch at ${state.cursor.height}`,
      };
    }
  }
  const fresh = new V3IndexerState(config);
  for (let h = 1n; h <= state.cursor.height; h++) {
    const hash = await provider.getBlockHash(Number(h));
    const block = await provider.getBlock(hash);
    fresh.applyBlock({
      height: h,
      hash: block.hash,
      parentHash: block.previousBlockHash,
      txs: block.rawTxs,
    });
  }
  const replayRoot = fresh.stateRoot();
  const dbRoot = state.stateRoot();
  if (dbRoot !== state.cursor.stateRoot) {
    return {
      ok: false,
      reason: `db root ${dbRoot} != cursor root ${state.cursor.stateRoot}`,
    };
  }
  if (replayRoot !== dbRoot) {
    return {
      ok: false,
      reason: `replay root ${replayRoot} != db root ${dbRoot}`,
    };
  }
  return { ok: true };
}
