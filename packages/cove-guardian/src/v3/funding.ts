export interface OutPointRef {
  txid: string;
  vout: number;
}
export type FundingInputCode =
  | "FUNDING_UNCONFIRMED"
  | "FUNDING_HOLDS_TOKEN"
  | "FUNDING_CHECK_UNAVAILABLE"
  | "FUNDING_PREVOUT_MISMATCH";
export type FundingInputVerdict =
  | {
      ok: true;
    }
  | {
      ok: false;
      code: FundingInputCode;
      detail: string;
    };
export interface FundingInputChecker {
  check(
    outpoint: OutPointRef,
    indexedHeight?: bigint,
    expected?: {
      script: Buffer;
      valueSats: bigint;
    },
  ): Promise<FundingInputVerdict>;
}
export interface TxOutReader {
  getTxout(
    txid: string,
    vout: number,
  ): Promise<{
    confirmations: number;
    scriptPubKeyHex?: string;
    valueSats?: bigint;
  } | null>;
  getBlockchainInfo?(): Promise<{
    blocks: number;
  }>;
}
export interface AssetLookup {
  describeAssets(outpoint: OutPointRef): Promise<string | null>;
}
const refuse = (
  code: FundingInputCode,
  detail: string,
): FundingInputVerdict => ({
  ok: false,
  code,
  detail,
});
export function chainFundingChecker(params: {
  chain: TxOutReader;
  isCoveCarrier: (outpoint: OutPointRef) => Promise<boolean>;
  assets?: AssetLookup;
  minConfirmations?: number;
}): FundingInputChecker {
  const minConf = params.minConfirmations ?? 1;
  return {
    async check(o, indexedHeight, expected) {
      const at = `${o.txid}:${o.vout}`;
      let txout: {
        confirmations: number;
        scriptPubKeyHex?: string;
        valueSats?: bigint;
      } | null;
      try {
        txout = await params.chain.getTxout(o.txid, o.vout);
      } catch (e) {
        return refuse(
          "FUNDING_CHECK_UNAVAILABLE",
          `could not look up ${at}: ${(e as Error).message}`,
        );
      }
      if (!txout)
        return refuse(
          "FUNDING_UNCONFIRMED",
          `funding input ${at} is spent or unknown`,
        );
      if (
        expected &&
        (txout.valueSats !== expected.valueSats ||
          txout.scriptPubKeyHex?.toLowerCase() !==
            expected.script.toString("hex"))
      ) {
        return refuse(
          "FUNDING_PREVOUT_MISMATCH",
          `funding input ${at} does not match its real Core prevout`,
        );
      }
      if (txout.confirmations < minConf) {
        return refuse(
          "FUNDING_UNCONFIRMED",
          `funding input ${at} is unconfirmed; wait for it to confirm`,
        );
      }
      if (indexedHeight !== undefined) {
        if (!params.chain.getBlockchainInfo)
          return refuse(
            "FUNDING_CHECK_UNAVAILABLE",
            "cannot compare funding confirmation with indexer cursor",
          );
        let coreHeight: bigint;
        try {
          coreHeight = BigInt((await params.chain.getBlockchainInfo()).blocks);
        } catch (e) {
          return refuse(
            "FUNDING_CHECK_UNAVAILABLE",
            `could not read Core height: ${(e as Error).message}`,
          );
        }
        const requiredConfirmations = coreHeight - indexedHeight + 1n;
        if (BigInt(txout.confirmations) < requiredConfirmations) {
          return refuse(
            "FUNDING_UNCONFIRMED",
            `funding input ${at} is newer than the indexed chain state`,
          );
        }
      }
      try {
        if (await params.isCoveCarrier(o))
          return refuse(
            "FUNDING_HOLDS_TOKEN",
            `funding input ${at} holds Cove tokens`,
          );
      } catch (e) {
        return refuse(
          "FUNDING_CHECK_UNAVAILABLE",
          `could not check ${at} for Cove tokens: ${(e as Error).message}`,
        );
      }
      if (params.assets) {
        let held: string | null;
        try {
          held = await params.assets.describeAssets(o);
        } catch (e) {
          return refuse(
            "FUNDING_CHECK_UNAVAILABLE",
            `could not check ${at} for inscriptions and runes: ${(e as Error).message}`,
          );
        }
        if (held)
          return refuse(
            "FUNDING_HOLDS_TOKEN",
            `funding input ${at} holds ${held}`,
          );
      }
      return { ok: true };
    },
  };
}
export function ordAssetLookup(
  baseUrl: string,
  opts: {
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
  } = {},
): AssetLookup {
  const base = baseUrl.replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 5000;
  return {
    async describeAssets(o) {
      const res = await doFetch(`${base}/output/${o.txid}:${o.vout}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`ord replied ${res.status}`);
      const body = (await res.json()) as {
        indexed?: unknown;
        inscriptions?: unknown;
        runes?: unknown;
      };
      if (body.indexed === false)
        throw new Error("ord has not indexed this output yet");
      if (!Array.isArray(body.inscriptions))
        throw new Error("ord reply has no inscriptions list");
      const runes = body.runes;
      const runeCount = Array.isArray(runes)
        ? runes.length
        : runes && typeof runes === "object"
          ? Object.keys(runes).length
          : -1;
      if (runeCount < 0)
        throw new Error(
          "ord reply has no runes field (is ord indexing runes?)",
        );
      const held: string[] = [];
      if (body.inscriptions.length > 0)
        held.push(`${body.inscriptions.length} inscription(s)`);
      if (runeCount > 0) held.push(`${runeCount} rune(s)`);
      return held.length > 0 ? held.join(" and ") : null;
    },
  };
}
