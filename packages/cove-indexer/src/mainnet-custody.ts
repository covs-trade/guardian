import { bitcoin } from "@crclaunch/bitcoin";
export type CustodyScriptType = "P2WPKH" | "P2TR";
export interface CustodyScript {
  address: string;
  scriptPubKeyHex: string;
  type: CustodyScriptType;
}
export function classifyScript(
  script: Uint8Array,
): CustodyScriptType | "UNSUPPORTED" {
  if (script.length === 22 && script[0] === 0x00 && script[1] === 0x14)
    return "P2WPKH";
  if (script.length === 34 && script[0] === 0x51 && script[1] === 0x20)
    return "P2TR";
  return "UNSUPPORTED";
}
export function decodeMainnetCustodyAddress(address: string): CustodyScript {
  let script: Buffer;
  try {
    script = bitcoin.address.toOutputScript(address, bitcoin.networks.bitcoin);
  } catch (e) {
    throw new Error(
      `invalid or wrong-network address "${address}": ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const type = classifyScript(script);
  if (type === "UNSUPPORTED") {
    throw new Error(
      `unsupported script type for "${address}" (only P2WPKH/P2TR are supported)`,
    );
  }
  const roundtrip = bitcoin.address.fromOutputScript(
    script,
    bitcoin.networks.bitcoin,
  );
  return { address: roundtrip, scriptPubKeyHex: script.toString("hex"), type };
}
