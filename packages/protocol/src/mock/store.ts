export interface MockStorage {
  read(): Promise<string | null>;
  write(json: string): Promise<void>;
  lock(): Promise<() => Promise<void>>;
}
export class MemoryStorage implements MockStorage {
  private value: string | null = null;
  private locked = false;
  async read(): Promise<string | null> {
    return this.value;
  }
  async write(json: string): Promise<void> {
    this.value = json;
  }
  async lock(): Promise<() => Promise<void>> {
    if (this.locked) {
      await new Promise((r) => setTimeout(r, 5));
      return this.lock();
    }
    this.locked = true;
    let released = false;
    return async () => {
      if (!released) {
        released = true;
        this.locked = false;
      }
    };
  }
}
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: any[]): Promise<any>;
  del(key: string): Promise<any>;
}
export class RedisMockStorage implements MockStorage {
  constructor(
    private readonly redis: RedisLike,
    private readonly key = "mock:chain:state",
    private readonly lockKey = "mock:chain:lock",
    private readonly lockTtlMs = 10000,
  ) {}
  async read(): Promise<string | null> {
    return this.redis.get(this.key);
  }
  async write(json: string): Promise<void> {
    await this.redis.set(this.key, json);
  }
  async lock(): Promise<() => Promise<void>> {
    for (;;) {
      const acquired = await this.redis.set(
        this.lockKey,
        "1",
        "NX",
        "PX",
        this.lockTtlMs,
      );
      if (acquired === "OK") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    return async () => {
      await this.redis.del(this.lockKey);
    };
  }
}
