import { schema, type DbTransaction } from "@crclaunch/db";
import { eq, and } from "drizzle-orm";
import type { V3IndexerState } from "./state.js";
import type {
  BlockUndo,
  UndoOp,
  V3BlockInput,
  V3Cursor,
  V3Event,
} from "./types.js";
import { encodeUndo } from "./undo.js";
const tables = schema;
export class V3Store {
  constructor(readonly network: string) {}
  async persistBlock(
    tx: DbTransaction,
    state: V3IndexerState,
    block: V3BlockInput,
    events: V3Event[],
    undo: BlockUndo,
    opts: {
      rebuilding: boolean;
    } = { rebuilding: false },
  ): Promise<void> {
    const n = this.network;
    await tx.insert(tables.coveV3Blocks).values({
      network: n,
      height: block.height,
      hash: block.hash,
      parentHash: block.parentHash,
      canonical: true,
    });
    if (events.length > 0) {
      await tx.insert(tables.coveV3Events).values(
        events.map((e) => ({
          network: n,
          txid: e.txid,
          blockHeight: e.blockHeight,
          blockHash: e.blockHash,
          txIndex: e.txIndex,
          operation: e.operation,
          valid: e.valid,
          reason: e.reason,
          tokenId: e.tokenId,
          canonical: true,
          amountAtoms: e.curve?.amountAtoms ?? null,
          grossSats: e.curve?.grossSats ?? null,
          feeSats: e.curve?.protocolFeeSats ?? null,
          supplyAfterAtoms: e.curve?.supplyAfterAtoms ?? null,
          backingAfterSats: e.curve?.backingAfterSats ?? null,
        })),
      );
    }
    await tx.insert(tables.coveV3Undo).values({
      network: n,
      height: block.height,
      blockHash: block.hash,
      undoJson: encodeUndo(undo),
    });
    for (const op of undo.ops) await this.applyForward(tx, state, op, block);
    await tx
      .insert(tables.coveV3Cursor)
      .values({
        network: n,
        height: block.height,
        blockHash: block.hash,
        stateRoot: state.stateRoot(),
        rebuilding: opts.rebuilding,
      })
      .onConflictDoUpdate({
        target: tables.coveV3Cursor.network,
        set: {
          height: block.height,
          blockHash: block.hash,
          stateRoot: state.stateRoot(),
          rebuilding: opts.rebuilding,
        },
      });
  }
  private async applyForward(
    tx: DbTransaction,
    state: V3IndexerState,
    op: UndoOp,
    block: V3BlockInput,
  ): Promise<void> {
    const n = this.network;
    switch (op.kind) {
      case "DEPLOY": {
        const meta = state.tokens.get(op.tokenId)!;
        const backing = state.backing.get(op.tokenId)!;
        await tx.insert(tables.coveV3Tokens).values({
          network: n,
          tokenId: op.tokenId,
          ticker: meta.ticker,
          policyVersion: meta.policyVersion,
          nonce: meta.tokenNonce,
          deployTxid: meta.deployTxid,
          deployHeight: meta.deployHeight,
          deployBlockHash: meta.deployBlockHash,
          creatorScript: meta.creatorScript,
          canonical: true,
        });
        await tx
          .insert(tables.coveV3BackingStates)
          .values(this.backingRow(backing));
        break;
      }
      case "MINT": {
        const backing = state.backing.get(op.tokenId)!;
        await tx
          .insert(tables.coveV3BackingStates)
          .values(this.backingRow(backing))
          .onConflictDoUpdate({
            target: [
              tables.coveV3BackingStates.network,
              tables.coveV3BackingStates.tokenId,
            ],
            set: this.backingSet(backing),
          });
        await tx
          .insert(tables.coveV3TokenUtxos)
          .values(this.utxoRow(op.createdUtxo));
        break;
      }
      case "TRANSFER": {
        for (const u of op.spentUtxos) {
          await tx
            .update(tables.coveV3TokenUtxos)
            .set({
              spentByTxid: op.spendingTxid,
              spentHeight: block.height,
              spentBlockHash: block.hash,
            })
            .where(
              and(
                eq(tables.coveV3TokenUtxos.network, n),
                eq(tables.coveV3TokenUtxos.txid, u.txid),
                eq(tables.coveV3TokenUtxos.vout, u.vout),
              ),
            );
        }
        for (const u of op.createdUtxos)
          await tx.insert(tables.coveV3TokenUtxos).values(this.utxoRow(u));
        break;
      }
      case "REDEEM": {
        const backing = state.backing.get(op.tokenId)!;
        await tx
          .insert(tables.coveV3BackingStates)
          .values(this.backingRow(backing))
          .onConflictDoUpdate({
            target: [
              tables.coveV3BackingStates.network,
              tables.coveV3BackingStates.tokenId,
            ],
            set: this.backingSet(backing),
          });
        for (const u of op.spentUtxos) {
          await tx
            .update(tables.coveV3TokenUtxos)
            .set({
              spentByTxid: op.spendingTxid,
              spentHeight: block.height,
              spentBlockHash: block.hash,
            })
            .where(
              and(
                eq(tables.coveV3TokenUtxos.network, n),
                eq(tables.coveV3TokenUtxos.txid, u.txid),
                eq(tables.coveV3TokenUtxos.vout, u.vout),
              ),
            );
        }
        for (const u of op.createdUtxos)
          await tx.insert(tables.coveV3TokenUtxos).values(this.utxoRow(u));
        break;
      }
      case "BURN": {
        for (const u of op.spentUtxos) {
          await tx
            .update(tables.coveV3TokenUtxos)
            .set({
              spentByTxid: op.spendingTxid,
              spentHeight: block.height,
              spentBlockHash: block.hash,
              burned: true,
            })
            .where(
              and(
                eq(tables.coveV3TokenUtxos.network, n),
                eq(tables.coveV3TokenUtxos.txid, u.txid),
                eq(tables.coveV3TokenUtxos.vout, u.vout),
              ),
            );
        }
        break;
      }
    }
  }
  async rollback(
    tx: DbTransaction,
    undo: BlockUndo,
    newCursor: V3Cursor,
  ): Promise<void> {
    const n = this.network;
    for (const op of [...undo.ops].reverse()) {
      switch (op.kind) {
        case "DEPLOY":
          await tx
            .delete(tables.coveV3Tokens)
            .where(
              and(
                eq(tables.coveV3Tokens.network, n),
                eq(tables.coveV3Tokens.tokenId, op.tokenId),
              ),
            );
          await tx
            .delete(tables.coveV3BackingStates)
            .where(
              and(
                eq(tables.coveV3BackingStates.network, n),
                eq(tables.coveV3BackingStates.tokenId, op.tokenId),
              ),
            );
          break;
        case "MINT":
          await tx
            .insert(tables.coveV3BackingStates)
            .values(this.backingRow(op.priorBacking))
            .onConflictDoUpdate({
              target: [
                tables.coveV3BackingStates.network,
                tables.coveV3BackingStates.tokenId,
              ],
              set: this.backingSet(op.priorBacking),
            });
          await tx
            .delete(tables.coveV3TokenUtxos)
            .where(
              and(
                eq(tables.coveV3TokenUtxos.network, n),
                eq(tables.coveV3TokenUtxos.txid, op.createdUtxo.txid),
                eq(tables.coveV3TokenUtxos.vout, op.createdUtxo.vout),
              ),
            );
          break;
        case "TRANSFER":
          for (const u of op.createdUtxos) {
            await tx
              .delete(tables.coveV3TokenUtxos)
              .where(
                and(
                  eq(tables.coveV3TokenUtxos.network, n),
                  eq(tables.coveV3TokenUtxos.txid, u.txid),
                  eq(tables.coveV3TokenUtxos.vout, u.vout),
                ),
              );
          }
          for (const u of op.spentUtxos) {
            await tx
              .insert(tables.coveV3TokenUtxos)
              .values(this.utxoRow(u))
              .onConflictDoUpdate({
                target: [
                  tables.coveV3TokenUtxos.network,
                  tables.coveV3TokenUtxos.txid,
                  tables.coveV3TokenUtxos.vout,
                ],
                set: {
                  spentByTxid: null,
                  spentHeight: null,
                  spentBlockHash: null,
                },
              });
          }
          break;
        case "REDEEM":
          await tx
            .insert(tables.coveV3BackingStates)
            .values(this.backingRow(op.priorBacking))
            .onConflictDoUpdate({
              target: [
                tables.coveV3BackingStates.network,
                tables.coveV3BackingStates.tokenId,
              ],
              set: this.backingSet(op.priorBacking),
            });
          for (const u of op.createdUtxos) {
            await tx
              .delete(tables.coveV3TokenUtxos)
              .where(
                and(
                  eq(tables.coveV3TokenUtxos.network, n),
                  eq(tables.coveV3TokenUtxos.txid, u.txid),
                  eq(tables.coveV3TokenUtxos.vout, u.vout),
                ),
              );
          }
          for (const u of op.spentUtxos) {
            await tx
              .insert(tables.coveV3TokenUtxos)
              .values(this.utxoRow(u))
              .onConflictDoUpdate({
                target: [
                  tables.coveV3TokenUtxos.network,
                  tables.coveV3TokenUtxos.txid,
                  tables.coveV3TokenUtxos.vout,
                ],
                set: {
                  spentByTxid: null,
                  spentHeight: null,
                  spentBlockHash: null,
                },
              });
          }
          break;
        case "BURN":
          for (const u of op.spentUtxos) {
            await tx
              .insert(tables.coveV3TokenUtxos)
              .values(this.utxoRow(u))
              .onConflictDoUpdate({
                target: [
                  tables.coveV3TokenUtxos.network,
                  tables.coveV3TokenUtxos.txid,
                  tables.coveV3TokenUtxos.vout,
                ],
                set: {
                  spentByTxid: null,
                  spentHeight: null,
                  spentBlockHash: null,
                  burned: false,
                },
              });
          }
          break;
      }
    }
    await tx
      .delete(tables.coveV3Undo)
      .where(
        and(
          eq(tables.coveV3Undo.network, n),
          eq(tables.coveV3Undo.height, undo.height),
        ),
      );
    await tx
      .delete(tables.coveV3Blocks)
      .where(
        and(
          eq(tables.coveV3Blocks.network, n),
          eq(tables.coveV3Blocks.height, undo.height),
        ),
      );
    await tx
      .delete(tables.coveV3Events)
      .where(
        and(
          eq(tables.coveV3Events.network, n),
          eq(tables.coveV3Events.blockHeight, undo.height),
        ),
      );
    await tx
      .insert(tables.coveV3Cursor)
      .values({
        network: n,
        height: newCursor.height,
        blockHash: newCursor.blockHash,
        stateRoot: newCursor.stateRoot,
        rebuilding: false,
      })
      .onConflictDoUpdate({
        target: tables.coveV3Cursor.network,
        set: {
          height: newCursor.height,
          blockHash: newCursor.blockHash,
          stateRoot: newCursor.stateRoot,
        },
      });
  }
  private backingRow(
    b: NonNullable<ReturnType<V3IndexerState["backing"]["get"]>>,
  ) {
    return {
      network: this.network,
      tokenId: b.tokenId,
      stateHash: b.stateHash,
      stateVersion: b.state.stateVersion,
      policyVersion: b.state.policyVersion,
      issuedSupplyAtoms: b.state.issuedPublicSupplyAtoms,
      backingSats: b.state.backingSats,
      curveStage: b.state.curveStage,
      txid: b.outpoint.txid,
      vout: b.outpoint.vout,
      scriptPubKey: b.scriptPubKey,
      btcValue: b.btcValue,
      blockHeight: b.updatedHeight,
      blockHash: b.updatedBlockHash,
      canonical: true,
    };
  }
  private backingSet(
    b: NonNullable<ReturnType<V3IndexerState["backing"]["get"]>>,
  ) {
    return {
      stateHash: b.stateHash,
      stateVersion: b.state.stateVersion,
      policyVersion: b.state.policyVersion,
      issuedSupplyAtoms: b.state.issuedPublicSupplyAtoms,
      backingSats: b.state.backingSats,
      curveStage: b.state.curveStage,
      txid: b.outpoint.txid,
      vout: b.outpoint.vout,
      scriptPubKey: b.scriptPubKey,
      btcValue: b.btcValue,
      blockHeight: b.updatedHeight,
      blockHash: b.updatedBlockHash,
    };
  }
  private utxoRow(
    u: NonNullable<ReturnType<V3IndexerState["tokenUtxos"]["get"]>>,
  ) {
    return {
      network: this.network,
      txid: u.txid,
      vout: u.vout,
      tokenId: u.tokenId,
      amountAtoms: u.amountAtoms,
      scriptPubKey: u.scriptPubKey,
      createdHeight: u.createdHeight,
      createdBlockHash: u.createdBlockHash,
      spentByTxid: null,
      spentHeight: null,
      spentBlockHash: null,
      canonical: true,
    };
  }
}
