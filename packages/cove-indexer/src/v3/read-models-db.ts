import { eq, and, or, isNull, desc } from "drizzle-orm";
import { schema, type Database } from "@crclaunch/db";
import {
  balanceByScript,
  currentBacking,
  tokenHolders,
  tokenUtxosByScript,
  type TokenDetail,
} from "./read-models.js";
export async function getTokenUtxosByScriptDb(
  db: Database,
  network: string,
  scriptPubKey: string,
) {
  return db
    .select()
    .from(schema.coveV3TokenUtxos)
    .where(
      and(
        eq(schema.coveV3TokenUtxos.network, network),
        eq(schema.coveV3TokenUtxos.scriptPubKey, scriptPubKey),
        eq(schema.coveV3TokenUtxos.canonical, true),
        isNull(schema.coveV3TokenUtxos.spentByTxid),
      ),
    );
}
export async function getLiveTokenUtxosAtDb(
  db: Database,
  network: string,
  outpoints: {
    txid: string;
    vout: number;
  }[],
) {
  if (outpoints.length === 0) return [];
  return db
    .select()
    .from(schema.coveV3TokenUtxos)
    .where(
      and(
        eq(schema.coveV3TokenUtxos.network, network),
        eq(schema.coveV3TokenUtxos.canonical, true),
        isNull(schema.coveV3TokenUtxos.spentByTxid),
        or(
          ...outpoints.map((o) =>
            and(
              eq(schema.coveV3TokenUtxos.txid, o.txid),
              eq(schema.coveV3TokenUtxos.vout, o.vout),
            ),
          ),
        ),
      ),
    );
}
export async function getBalanceByScriptDb(
  db: Database,
  network: string,
  tokenId: string,
  scriptPubKey: string,
): Promise<bigint> {
  const rows = await db
    .select({ amountAtoms: schema.coveV3TokenUtxos.amountAtoms })
    .from(schema.coveV3TokenUtxos)
    .where(
      and(
        eq(schema.coveV3TokenUtxos.network, network),
        eq(schema.coveV3TokenUtxos.tokenId, tokenId),
        eq(schema.coveV3TokenUtxos.scriptPubKey, scriptPubKey),
        eq(schema.coveV3TokenUtxos.canonical, true),
        isNull(schema.coveV3TokenUtxos.spentByTxid),
      ),
    );
  return rows.reduce((s, r) => s + r.amountAtoms, 0n);
}
export async function getTokenHoldersDb(
  db: Database,
  network: string,
  tokenId: string,
) {
  const rows = await db
    .select()
    .from(schema.coveV3TokenUtxos)
    .where(
      and(
        eq(schema.coveV3TokenUtxos.network, network),
        eq(schema.coveV3TokenUtxos.tokenId, tokenId),
        eq(schema.coveV3TokenUtxos.canonical, true),
        isNull(schema.coveV3TokenUtxos.spentByTxid),
      ),
    );
  return tokenHolders(rows, tokenId);
}
export async function getCurrentBackingDb(
  db: Database,
  network: string,
  tokenId: string,
) {
  return db
    .select()
    .from(schema.coveV3BackingStates)
    .where(
      and(
        eq(schema.coveV3BackingStates.network, network),
        eq(schema.coveV3BackingStates.tokenId, tokenId),
        eq(schema.coveV3BackingStates.canonical, true),
      ),
    );
}
export async function getTokenDetailDb(
  db: Database,
  network: string,
  tokenId: string,
  publicCapAtoms: bigint,
): Promise<TokenDetail | null> {
  const token = await db
    .select()
    .from(schema.coveV3Tokens)
    .where(
      and(
        eq(schema.coveV3Tokens.network, network),
        eq(schema.coveV3Tokens.tokenId, tokenId),
        eq(schema.coveV3Tokens.canonical, true),
      ),
    );
  const backing = await db
    .select()
    .from(schema.coveV3BackingStates)
    .where(
      and(
        eq(schema.coveV3BackingStates.network, network),
        eq(schema.coveV3BackingStates.tokenId, tokenId),
        eq(schema.coveV3BackingStates.canonical, true),
      ),
    );
  const utxos = await db
    .select()
    .from(schema.coveV3TokenUtxos)
    .where(
      and(
        eq(schema.coveV3TokenUtxos.network, network),
        eq(schema.coveV3TokenUtxos.tokenId, tokenId),
        eq(schema.coveV3TokenUtxos.canonical, true),
        isNull(schema.coveV3TokenUtxos.spentByTxid),
      ),
    );
  if (token.length === 0 || backing.length === 0) return null;
  const t = token[0]!;
  const b = backing[0]!;
  return currentBacking(
    {
      tokenId: t.tokenId,
      ticker: t.ticker,
      policyVersion: t.policyVersion,
      tokenNonce: t.nonce,
      deployTxid: t.deployTxid,
      deployHeight: t.deployHeight,
      deployBlockHash: t.deployBlockHash,
      creatorScript: t.creatorScript,
    },
    {
      tokenId: b.tokenId,
      state: {
        stateVersion: b.stateVersion as 2,
        policyVersion: b.policyVersion,
        tokenId: b.tokenId,
        issuedPublicSupplyAtoms: b.issuedSupplyAtoms,
        backingSats: b.backingSats,
        curveStage: b.curveStage,
      },
      stateHash: b.stateHash,
      outpoint: { txid: b.txid, vout: b.vout },
      scriptPubKey: b.scriptPubKey,
      btcValue: b.btcValue,
      updatedTxid: b.txid,
      updatedHeight: b.blockHeight,
      updatedBlockHash: b.blockHash,
    },
    utxos,
    publicCapAtoms,
  );
}
export async function getTokenActivityDb(
  db: Database,
  network: string,
  tokenId: string,
  limit = 100,
) {
  return db
    .select()
    .from(schema.coveV3Events)
    .where(
      and(
        eq(schema.coveV3Events.network, network),
        eq(schema.coveV3Events.tokenId, tokenId),
        eq(schema.coveV3Events.canonical, true),
      ),
    )
    .orderBy(
      desc(schema.coveV3Events.blockHeight),
      desc(schema.coveV3Events.txIndex),
    )
    .limit(limit);
}
export { balanceByScript, tokenHolders, tokenUtxosByScript };
