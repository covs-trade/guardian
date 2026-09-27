import type { CoreRpcProvider } from "@crclaunch/bitcoin";
import type { GuardianV3Network } from "./types.js";
import type { ValidatedCoveTransaction } from "./finalize.js";
export interface BroadcastResult {
  txid: string;
  mempoolAcceptAllowed: boolean;
}
export async function broadcastValidatedCoveTransaction(params: {
  validated: ValidatedCoveTransaction;
  network: GuardianV3Network;
  provider: CoreRpcProvider;
}): Promise<BroadcastResult> {
  if (params.network === "mainnet") {
    const chain = (await params.provider.getBlockchainInfo()).chain;
    if (chain !== "main")
      throw new Error(
        `WRONG_CHAIN: mainnet broadcast, but the node is on "${chain}"`,
      );
  }
  const accept = await params.provider.testMempoolAccept(
    params.validated.rawTxHex,
  );
  if (accept.allowed !== true) {
    throw new Error(
      `testmempoolaccept rejected: ${accept.rejectReason ?? "unknown"}`,
    );
  }
  const txid = await params.provider.broadcastTransaction(
    params.validated.rawTxHex,
  );
  if (txid !== params.validated.txid) {
    throw new Error(
      `TXID_MISMATCH: broadcast ${txid} != validated ${params.validated.txid}`,
    );
  }
  return { txid, mempoolAcceptAllowed: accept.allowed };
}
