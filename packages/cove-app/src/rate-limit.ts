export interface RateLimitKey {
  scope: string;
  subject: string;
  operation: string;
}
export interface RateLimitConfig {
  limit: number;
  windowMs: number;
}
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}
export interface RateLimiter {
  check(
    key: RateLimitKey,
    config: RateLimitConfig,
    now?: number,
  ): RateLimitResult;
}
export class FixedWindowRateLimiter implements RateLimiter {
  private windows = new Map<
    string,
    {
      start: number;
      count: number;
    }
  >();
  check(
    key: RateLimitKey,
    config: RateLimitConfig,
    now = Date.now(),
  ): RateLimitResult {
    const k = `${key.scope}:${key.subject}:${key.operation}`;
    const start = now - (now % config.windowMs);
    const w = this.windows.get(k);
    if (!w || w.start !== start) {
      this.windows.set(k, { start, count: 1 });
      return { allowed: true, remaining: config.limit - 1, retryAfterMs: 0 };
    }
    if (w.count >= config.limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: start + config.windowMs - now,
      };
    }
    w.count += 1;
    return {
      allowed: true,
      remaining: config.limit - w.count,
      retryAfterMs: 0,
    };
  }
}
