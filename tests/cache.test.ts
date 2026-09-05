import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deduplicate, ExpiringCache } from '../src/main/cache'

/** A clock the test moves, so a ten-minute expiry costs nothing to reach. */
function clock(start = 1_000) {
  let now = start
  return { now: () => now, advance: (ms: number) => { now += ms } }
}

test('a value comes back until it expires, and not after', () => {
  const time = clock()
  const cache = new ExpiringCache<string>(10, time.now)
  cache.set('zerator', 'live', 60_000)
  assert.equal(cache.get('zerator'), 'live')
  time.advance(59_999)
  assert.equal(cache.get('zerator'), 'live')
  time.advance(2)
  assert.equal(cache.get('zerator'), null)
})

test('an expired entry is released, not merely ignored', () => {
  // The defect this class exists for: the caches it replaces compared a timestamp on read and
  // kept the entry either way, so a long session accumulated every channel it had ever seen.
  const time = clock()
  const cache = new ExpiringCache<string>(1000, time.now)
  for (let index = 0; index < 200; index++) cache.set(`channel-${index}`, 'x', 60_000)
  assert.equal(cache.size, 200)
  time.advance(60_001)
  // Nobody reads them again — a channel visited once and left behind is exactly that — so the
  // release has to happen on somebody else's write.
  cache.set('someone-else', 'x', 60_000)
  assert.equal(cache.size, 1)
})

test('the ceiling holds however many channels a session goes through', () => {
  const time = clock()
  const cache = new ExpiringCache<number>(50, time.now)
  for (let index = 0; index < 5_000; index++) cache.set(`channel-${index}`, index, 60 * 60_000)
  assert.equal(cache.size, 50)
  // The oldest writes are the ones that went.
  assert.equal(cache.get('channel-0'), null)
  assert.equal(cache.get('channel-4999'), 4999)
  assert.equal(cache.get('channel-4950'), 4950)
  assert.equal(cache.get('channel-4949'), null)
})

test('a key written to again survives the eviction of its neighbours', () => {
  const time = clock()
  const cache = new ExpiringCache<string>(3, time.now)
  cache.set('a', 'a', 60_000); cache.set('b', 'b', 60_000); cache.set('c', 'c', 60_000)
  cache.set('a', 'a again', 60_000)
  cache.set('d', 'd', 60_000)
  // `b` was the oldest write once `a` was rewritten, so `b` is the one that goes.
  assert.equal(cache.get('b'), null)
  assert.equal(cache.get('a'), 'a again')
  assert.equal(cache.get('d'), 'd')
})

test('deleting and clearing do what they say', () => {
  const cache = new ExpiringCache<string>(10)
  cache.set('a', 'a', 60_000); cache.set('b', 'b', 60_000)
  cache.delete('a')
  assert.equal(cache.get('a'), null)
  assert.equal(cache.size, 1)
  cache.clear()
  assert.equal(cache.size, 0)
})

test('two callers asking for the same thing at once make one call', async () => {
  const inFlight = new Map<string, Promise<string>>()
  let calls = 0
  let release = (_: string) => {}
  const start = () => { calls++; return new Promise<string>(resolve => { release = resolve }) }
  const first = deduplicate(inFlight, 'zerator', start)
  const second = deduplicate(inFlight, 'zerator', start)
  assert.equal(calls, 1)
  release('emotes')
  assert.deepEqual([await first, await second], ['emotes', 'emotes'])
  // Released once it answers: the next caller asks again rather than reading a stale promise.
  assert.equal(inFlight.size, 0)
})

test('a failure is never what the next caller inherits', async () => {
  const inFlight = new Map<string, Promise<string>>()
  let calls = 0
  const failing = () => { calls++; return Promise.reject(new Error('network is away')) }
  await assert.rejects(deduplicate(inFlight, 'zerator', failing))
  assert.equal(inFlight.size, 0)
  await assert.rejects(deduplicate(inFlight, 'zerator', failing))
  assert.equal(calls, 2)
})

test('different keys never share an answer', async () => {
  const inFlight = new Map<string, Promise<string>>()
  const answers = deduplicate(inFlight, 'a', async () => 'first')
  const other = deduplicate(inFlight, 'b', async () => 'second')
  assert.deepEqual([await answers, await other], ['first', 'second'])
})
