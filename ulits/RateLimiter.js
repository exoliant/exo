/**
 * A concurrency-limiting semaphore, converted from this Python pattern:
 *
 *   rate_limiter = asyncio.Semaphore(20)
 *
 *   async def ping_channel(channel, message, num_pings, rate_limiter):
 *     for _ in range(num_pings):
 *       await rate_limiter.acquire()
 *       await channel.send(message)
 *       rate_limiter.release()
 *       await asyncio.sleep(0.1)
 *
 * Same idea: acquire() blocks until a slot is free, release() frees it for
 * the next queued caller. JS has no built-in Semaphore, so this implements
 * one with a counter and a FIFO queue of waiting resolvers.
 *
 * Important distinction from Discord's real rate limits: this does NOT
 * replace discord.js's own built-in rate-limit handling (which already
 * queues/retries against Discord's actual per-route limits under the hood).
 * This is an additional, coarser cap on how many restoration operations
 * RestoreManager fires at once, so a large restore doesn't blast 50+
 * requests in one tick and guarantee it gets throttled hard. Tune the
 * concurrency/delay values in config.js if you observe real 429s during
 * large restores - they're deliberately conservative defaults, not
 * measured against Discord's actual bucket limits.
 */
class RateLimiter {
  /**
   * @param {number} maxConcurrent - how many acquire()'d operations can run at once
   * @param {number} minDelayMs - minimum pause after an operation finishes, before releasing its slot
   */
  constructor(maxConcurrent, minDelayMs = 100) {
    this.maxConcurrent = maxConcurrent;
    this.minDelayMs = minDelayMs;
    this.current = 0;
    this.queue = [];
  }

  acquire() {
    return new Promise((resolve) => {
      const tryAcquire = () => {
        if (this.current < this.maxConcurrent) {
          this.current++;
          resolve();
        } else {
          this.queue.push(tryAcquire);
        }
      };
      tryAcquire();
    });
  }

  release() {
    this.current--;
    const next = this.queue.shift();
    if (next) next();
  }

  /**
   * Runs fn() under the semaphore: acquire -> run -> pace -> release.
   * This is the Node equivalent of the acquire/send/release/sleep loop
   * body in the Python version, wrapped so callers don't have to manage
   * acquire/release/try-finally themselves at every call site.
   *
   * @param {() => Promise<any>} fn
   */
  async run(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      if (this.minDelayMs > 0) {
        await new Promise((r) => setTimeout(r, this.minDelayMs));
      }
      this.release();
    }
  }
}

module.exports = RateLimiter;
