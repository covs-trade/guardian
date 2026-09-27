import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
export function requireAuthToken(token: string | undefined): string {
  if (!token || token.length === 0) {
    throw new Error(
      "GUARDIAN_AUTH_TOKEN is required (refusing to boot without a non-empty token)",
    );
  }
  return token;
}
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}
export class FixedWindowRateLimiter {
  private readonly windowMs: number;
  private readonly maxRequests: number;
  private readonly buckets = new Map<
    string,
    {
      count: number;
      windowStart: number;
    }
  >();
  constructor(windowMs = 60000, maxRequests = 120) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
  }
  allow(key: string, now = Date.now()): boolean {
    const b = this.buckets.get(key);
    if (!b || now - b.windowStart >= this.windowMs) {
      this.buckets.set(key, { count: 1, windowStart: now });
      return true;
    }
    b.count += 1;
    return b.count <= this.maxRequests;
  }
}
export function readJsonWithLimit(
  req: IncomingMessage,
  maxBytes: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) {
        reject(new Error(`request body exceeds ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(
          chunks.length
            ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
            : {},
        );
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}
