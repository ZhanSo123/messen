export class TokenBucketRateLimiter {
    opts;
    buckets = new Map();
    constructor(opts) {
        this.opts = opts;
    }
    consume(key, cost = 1) {
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
        if (b.tokens < cost)
            return false;
        b.tokens -= cost;
        return true;
    }
}
