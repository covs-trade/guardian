export function canonicalTicker(ticker: string): string {
  if (!/^[A-Za-z][A-Za-z0-9]{0,15}$/.test(ticker)) {
    throw new Error(
      "ticker must be 1..16 alphanumeric, starting with a letter",
    );
  }
  return ticker.toUpperCase();
}
