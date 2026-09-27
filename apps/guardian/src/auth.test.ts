import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import {
  requireAuthToken,
  safeEqual,
  FixedWindowRateLimiter,
  readJsonWithLimit,
} from "./auth.js";
describe("Guardian auth hardening (P0-1)", () => {
  it("refuses to boot without a non-empty token", () => {
    expect(() => requireAuthToken(undefined)).toThrow(
      /GUARDIAN_AUTH_TOKEN is required/,
    );
    expect(() => requireAuthToken("")).toThrow(
      /GUARDIAN_AUTH_TOKEN is required/,
    );
    expect(requireAuthToken("secret")).toBe("secret");
  });
  it("compares tokens (constant time) correctly", () => {
    expect(safeEqual("Bearer abc", "Bearer abc")).toBe(true);
    expect(safeEqual("Bearer abc", "Bearer abd")).toBe(false);
    expect(safeEqual("", "Bearer abc")).toBe(false);
  });
  it("rate-limits beyond the window", () => {
    const rl = new FixedWindowRateLimiter(60000, 3);
    expect(rl.allow("ip", 0)).toBe(true);
    expect(rl.allow("ip", 1)).toBe(true);
    expect(rl.allow("ip", 2)).toBe(true);
    expect(rl.allow("ip", 3)).toBe(false);
    expect(rl.allow("ip", 60000)).toBe(true);
  });
  it("rejects a body over the size limit", async () => {
    const req = Readable.from([
      Buffer.from(JSON.stringify({ x: "a".repeat(100) })),
    ]) as unknown as IncomingMessage;
    await expect(readJsonWithLimit(req, 10)).rejects.toThrow(
      /exceeds 10 bytes/,
    );
  });
  it("parses a body under the size limit", async () => {
    const req = Readable.from([
      Buffer.from(JSON.stringify({ a: 1 })),
    ]) as unknown as IncomingMessage;
    await expect(readJsonWithLimit(req, 1000000)).resolves.toEqual({ a: 1 });
  });
});
