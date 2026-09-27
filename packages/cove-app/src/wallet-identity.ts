import { spendKindOf, type SpendKind } from "@crclaunch/bitcoin";
import { AppError } from "./errors.js";
export interface WalletRole {
  script: string;
  publicKey?: string;
}
export interface WalletIdentity {
  payments: WalletRole;
  ordinals: WalletRole;
}
export interface ResolvedRole extends WalletRole {
  kind: SpendKind;
  scriptBuffer: Buffer;
  publicKeyBuffer?: Buffer;
}
export interface ResolvedWalletIdentity {
  payments: ResolvedRole;
  ordinals: ResolvedRole;
  scripts: string[];
}
function resolveRole(role: WalletRole, label: string): ResolvedRole {
  if (!/^[0-9a-f]+$/i.test(role.script) || role.script.length < 4) {
    throw new AppError("FUNDING_INPUT_INVALID", `${label} script is not hex`);
  }
  const scriptBuffer = Buffer.from(role.script, "hex");
  const kind = spendKindOf(scriptBuffer);
  if (kind === null) {
    throw new AppError(
      "WALLET_UNSUPPORTED",
      `${label} address type is not supported; Cove can spend native segwit, ` +
        `nested segwit and Taproot`,
    );
  }
  if (kind !== "p2wpkh" && !role.publicKey) {
    throw new AppError(
      "WALLET_UNSUPPORTED",
      `a ${kind} ${label} address needs its public key, which the wallet did not supply`,
    );
  }
  if (
    role.publicKey &&
    !/^[0-9a-f]{66}$|^[0-9a-f]{64}$/i.test(role.publicKey)
  ) {
    throw new AppError(
      "WALLET_UNSUPPORTED",
      `${label} public key is not a 32 or 33-byte hex key`,
    );
  }
  return {
    ...role,
    script: role.script.toLowerCase(),
    kind,
    scriptBuffer,
    publicKeyBuffer: role.publicKey
      ? Buffer.from(role.publicKey, "hex")
      : undefined,
  };
}
export function resolveWalletIdentity(
  identity: WalletIdentity,
): ResolvedWalletIdentity {
  const payments = resolveRole(identity.payments, "payment");
  const ordinals =
    identity.ordinals.script.toLowerCase() ===
    identity.payments.script.toLowerCase()
      ? payments
      : resolveRole(identity.ordinals, "ordinals");
  const scripts = [payments.script];
  if (ordinals.script !== payments.script) scripts.push(ordinals.script);
  return { payments, ordinals, scripts };
}
export function walletIdentityFrom(input: {
  walletScript?: string;
  walletPublicKey?: string;
  ordinalsScript?: string;
  ordinalsPublicKey?: string;
}): WalletIdentity {
  const paymentsScript = input.walletScript ?? "";
  return {
    payments: { script: paymentsScript, publicKey: input.walletPublicKey },
    ordinals: {
      script: input.ordinalsScript || paymentsScript,
      publicKey: input.ordinalsScript
        ? input.ordinalsPublicKey
        : input.walletPublicKey,
    },
  };
}
