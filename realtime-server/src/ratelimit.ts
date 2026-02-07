type Bucket = { tokens: number; lastRefillMs: number };

export class TokenBucketRateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(
    private opts: {
      capacity: number;
      refillTokens: number;
      refillMs: number;
    }
  ) {}

  consume(key: string, cost = 1): boolean {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.opts.capacity, lastRefillMs: now };
      this.buckets.set(key, b);
    }

    const elapsed = now - b.lastRefillMs;
    if (elapsed > 0) {
      const refills = Math.floor(elapsed / this.opts.refillMs);
      if (refills > 0) {
        const add = refills * this.opts.refillTokens;
        b.tokens = Math.min(this.opts.capacity, b.tokens + add);
        b.lastRefillMs += refills * this.opts.refillMs;
      }
    }

    if (b.tokens < cost) return false;
    b.tokens -= cost;
    return true;
  }
}

