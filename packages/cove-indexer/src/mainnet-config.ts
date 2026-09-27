import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
loadEnv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });
import { decodeMainnetCustodyAddress } from "./mainnet-custody.js";
function decodeAddress(label: string, address: string): void {
  try {
    const custody = decodeMainnetCustodyAddress(address);
    console.log(`${label}`);
    console.log(`  address:      ${custody.address}`);
    console.log(`  scriptPubKey: ${custody.scriptPubKeyHex}`);
    console.log(`  script type:  ${custody.type}`);
  } catch (e) {
    console.error(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
const treasury = process.env.COVE_MAINNET_TREASURY_ADDRESS;
const settlement = process.env.COVE_MAINNET_SETTLEMENT_ADDRESS;
if (!treasury || !settlement) {
  console.error(
    "Both COVE_MAINNET_TREASURY_ADDRESS and COVE_MAINNET_SETTLEMENT_ADDRESS are required.",
  );
  console.error("MAINNET TREASURY ADDRESS: REQUIRED");
  console.error("MAINNET SETTLEMENT ADDRESS: REQUIRED");
  process.exit(1);
}
console.log("Cove V1 mainnet custody intake (mainnet parameters)");
decodeAddress("TREASURY", treasury);
decodeAddress("SETTLEMENT", settlement);
console.log(
  "✓ addresses decode as mainnet P2WPKH/P2TR. No private keys were generated, printed, or stored.",
);
