/**
 * Generic LRU cache with hit/miss timing instrumentation.
 *
 * Shared by the memoized stream-analytics modules (`Module26`, `Module36`,
 * `Module48`) so the eviction and speedup-measurement logic lives in one
 * place instead of being re-implemented identically in each of them.
 */

export interface MemoCacheMetrics {
  cacheHits: number;
  cacheMisses: number;
  /**
   * `(avgMissMs - avgHitMs) / avgMissMs * 100`, measured from this
   * instance's own accumulated hit/miss timings - not a fixed assumption.
   * `null` until at least one hit and one miss have both been recorded.
   */
  measuredSpeedupPercent: number | null;
}

export interface LruMemoCacheOptions {
  /** Entries kept before the least-recently-used one is evicted. */
  maxEntries: number;
  /**
   * Default time-to-live in milliseconds for `set()` calls that pass no
   * `ttlMs`. Omit for entries that never expire by default.
   */
  ttlMs?: number;
}

export class LruMemoCache<K, V> {
  private readonly store = new Map<K, V>();
  /** Absolute expiry (epoch ms) for entries stored with a `ttlMs`. */
  private readonly expiresAt = new Map<K, number>();
  private cacheHits = 0;
  private cacheMisses = 0;
  private hitExecutionTimeMs = 0;
  private missExecutionTimeMs = 0;
  private readonly maxSize: number;
  private readonly defaultTtlMs: number | undefined;

  /**
   * Accepts either a bare max entry count (the original form) or
   * {@link LruMemoCacheOptions}.
   */
  constructor(options: number | LruMemoCacheOptions) {
    const resolved = typeof options === 'number' ? { maxEntries: options } : options;
    this.maxSize = resolved.maxEntries;
    this.defaultTtlMs = resolved.ttlMs;
    if (this.defaultTtlMs !== undefined && (!Number.isFinite(this.defaultTtlMs) || this.defaultTtlMs <= 0)) {
      throw new RangeError('LruMemoCache ttlMs must be a positive finite number');
    }
  }

  get size(): number {
    return this.store.size;
  }

  private isExpired(key: K): boolean {
    const expiry = this.expiresAt.get(key);
    return expiry !== undefined && Date.now() >= expiry;
  }

  private remove(key: K): void {
    this.store.delete(key);
    this.expiresAt.delete(key);
  }

  /**
   * Look up a key, refreshing its LRU position on hit. An entry past its
   * `ttlMs` is dropped and reported as a miss.
   */
  get(key: K): V | undefined {
    if (this.isExpired(key)) {
      this.remove(key);
      return undefined;
    }
    const value = this.store.get(key);
    if (value !== undefined) {
      this.store.delete(key);
      this.store.set(key, value);
    }
    return value;
  }

  /**
   * Insert a key, evicting the least-recently-used entry if at capacity.
   *
   * @param ttlMs Optional time-to-live in milliseconds. Once elapsed the entry
   *   is no longer returned by `get()`. Defaults to the cache's configured
   *   `ttlMs`; if that is also unset the entry never expires. Re-setting a key
   *   replaces any previous TTL.
   */
  set(key: K, value: V, ttlMs: number | undefined = this.defaultTtlMs): void {
    if (ttlMs !== undefined && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
      throw new RangeError('LruMemoCache ttlMs must be a positive finite number');
    }
    if (this.store.has(key)) {
      this.remove(key);
    } else if (this.store.size >= this.maxSize) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.remove(oldest);
    }
    this.store.set(key, value);
    if (ttlMs !== undefined) this.expiresAt.set(key, Date.now() + ttlMs);
  }

  recordHit(elapsedMs: number): void {
    this.cacheHits++;
    this.hitExecutionTimeMs += elapsedMs;
  }

  recordMiss(elapsedMs: number): void {
    this.cacheMisses++;
    this.missExecutionTimeMs += elapsedMs;
  }

  clear(): void {
    this.store.clear();
    this.expiresAt.clear();
    this.cacheHits = 0;
    this.cacheMisses = 0;
    this.hitExecutionTimeMs = 0;
    this.missExecutionTimeMs = 0;
  }

  metrics(): MemoCacheMetrics {
    const avgHitMs = this.cacheHits > 0 ? this.hitExecutionTimeMs / this.cacheHits : null;
    const avgMissMs = this.cacheMisses > 0 ? this.missExecutionTimeMs / this.cacheMisses : null;
    const measuredSpeedupPercent =
      avgHitMs !== null && avgMissMs !== null && avgMissMs > 0
        ? ((avgMissMs - avgHitMs) / avgMissMs) * 100
        : null;

    return { cacheHits: this.cacheHits, cacheMisses: this.cacheMisses, measuredSpeedupPercent };
  }
}