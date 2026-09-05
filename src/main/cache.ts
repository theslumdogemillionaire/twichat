/**
 * A cache that forgets, in both senses.
 *
 * The caches this replaces kept a timestamp per entry and compared it on read, which invalidates
 * a value without ever removing it. A session that visits a thousand channels — the discovery
 * list makes that ordinary — left a thousand entries behind, all expired, none released. Nothing
 * measured a leak; there was simply no bound, and that is the thing to fix rather than argue
 * about how long a session has to run before it matters.
 *
 * So: expired entries are dropped on the way past, and a ceiling evicts the oldest write when the
 * map would grow beyond it. Insertion order is the eviction order — `Map` keeps it, and a write
 * to an existing key moves it back to the end, so a key written to often survives.
 */
export class ExpiringCache<T> {
  private readonly entries = new Map<string, { expires: number; value: T }>()

  /**
   * @param max how many entries may live at once. Reached, the oldest write goes.
   * @param now the clock, injected so a test can move it rather than wait.
   */
  constructor(private readonly max: number, private readonly now: () => number = Date.now) {}

  /** The value, or null when there is none or it has expired — an expired one is dropped here. */
  get(key: string): T | null {
    const entry = this.entries.get(key)
    if (!entry) return null
    if (entry.expires > this.now()) return entry.value
    this.entries.delete(key)
    return null
  }

  set(key: string, value: T, ttl: number): T {
    // A rewrite is a fresh write: deleting first puts the key back at the end of the order.
    this.entries.delete(key)
    this.entries.set(key, { value, expires: this.now() + ttl })
    this.purge()
    return value
  }

  delete(key: string) { this.entries.delete(key) }
  clear() { this.entries.clear() }
  get size() { return this.entries.size }

  /**
   * Everything past its date goes, then the oldest writes until the ceiling is met. The sweep is
   * over entries rather than on a timer: a cache nobody writes to costs nothing and holds nothing
   * worth reclaiming, and a timer would keep the process awake to say so.
   */
  private purge() {
    const now = this.now()
    for (const [key, entry] of this.entries) if (entry.expires <= now) this.entries.delete(key)
    if (this.entries.size <= this.max) return
    for (const key of this.entries.keys()) {
      if (this.entries.size <= this.max) break
      this.entries.delete(key)
    }
  }
}

/**
 * Folds concurrent identical calls into one.
 *
 * Joining a channel asks for its emotes from four providers at once, and the room list repaints
 * while the first repaint's request is still out. Without this the same answer is fetched twice
 * and written twice; with it the second caller waits on the first. The entry is released in a
 * `finally`, so a rejection is never cached — the next caller tries again rather than inheriting
 * a failure.
 */
export function deduplicate<T>(inFlight: Map<string, Promise<T>>, key: string, start: () => Promise<T>): Promise<T> {
  const running = inFlight.get(key)
  if (running) return running
  const promise = start().finally(() => { inFlight.delete(key) })
  inFlight.set(key, promise)
  return promise
}
