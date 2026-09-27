import {
  CURVES,
  PUBLIC_SUPPLY,
  TOTAL_SUPPLY,
  PRICE_UNIT,
  type Curve,
} from "./curve.js";
const FRACTIONS: [string, bigint][] = [
  ["0%", 0n],
  ["10%", PUBLIC_SUPPLY / 10n],
  ["25%", PUBLIC_SUPPLY / 4n],
  ["50%", PUBLIC_SUPPLY / 2n],
  ["75%", (PUBLIC_SUPPLY * 3n) / 4n],
  ["90%", (PUBLIC_SUPPLY * 9n) / 10n],
  ["100%", PUBLIC_SUPPLY],
];
function satsToBtc(sats: bigint): string {
  const whole = sats / 100000000n;
  const frac = sats % 100000000n;
  return `${whole}.${frac.toString().padStart(8, "0")} BTC`;
}
function valuation(marginalPriceSats: bigint): string {
  const sats = (marginalPriceSats * TOTAL_SUPPLY) / PRICE_UNIT;
  return satsToBtc(sats);
}
function whaleImpact(curve: Curve): {
  single: bigint;
  split: bigint;
  drift: bigint;
} {
  const amount = PUBLIC_SUPPLY / 10n;
  const single = curve.costToBuy(0n, amount);
  const parts = 100;
  const partAmount = amount / BigInt(parts);
  let split = 0n;
  let s = 0n;
  for (let i = 0; i < parts; i++) {
    split += curve.costToBuy(s, partAmount);
    s += partAmount;
  }
  return { single, split, drift: split - single };
}
function report(): void {
  const line = "─".repeat(100);
  console.log(line);
  console.log("COVE BONDING-CURVE COMPARISON (integer-only, deterministic)");
  console.log(
    `public=${PUBLIC_SUPPLY} total=${TOTAL_SUPPLY} reserved=${TOTAL_SUPPLY - PUBLIC_SUPPLY}`,
  );
  console.log(line);
  for (const curve of CURVES) {
    console.log(`\n${curve.name}  [${curve.id}]`);
    console.log(`  complexity: ${curve.complexity}`);
    let lastRaise = 0n;
    for (const [label, supply] of FRACTIONS) {
      const price = curve.priceAt(supply);
      const raise = curve.costToBuy(0n, supply);
      lastRaise = raise;
      console.log(
        `    ${label.padEnd(6)} supply=${String(supply).padStart(9)}  price=${String(price).padStart(7)} sats/M  raised=${satsToBtc(raise)}`,
      );
    }
    const finalReserve = lastRaise;
    const marginal = curve.priceAt(PUBLIC_SUPPLY);
    const { single, split, drift } = whaleImpact(curve);
    console.log(`    final reserve            : ${satsToBtc(finalReserve)}`);
    console.log(`    final marginal price     : ${marginal} sats/M`);
    console.log(`    implied valuation (FDV)  : ${valuation(marginal)}`);
    console.log(
      `    whale buy 10% (1 tx)     : ${satsToBtc(single)}   100-split: ${satsToBtc(split)}   drift=${drift} sats`,
    );
  }
  console.log("\n" + line);
}
import { pathToFileURL } from "node:url";
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  report();
}
