import test from 'node:test'
import assert from 'node:assert/strict'
import { createAccountData, type AccountDataParts } from '../src/main/account-data'
import { errorKey } from '../src/shared/errors'
import type { FollowedChannels, StreamSummary } from '../src/shared/types'

const stream = (channel: string): StreamSummary => ({
  id: channel, channel, displayName: channel, avatarUrl: '', thumbnailUrl: '',
  title: '', game: '', viewers: 1, tags: [], language: 'fr', startedAt: ''
})
const followed = (login: string): FollowedChannels => ({ live: [stream(login)], offline: [], truncated: false })

/** A session the test moves, and calls it can answer whenever it likes. */
function harness(overrides: Partial<AccountDataParts> = {}) {
  let session = { token: 'token-of-alice' as string | null, clientId: 'client', userId: '1' as string | null, follows: true, generation: 1 }
  let time = 1_000_000
  const calls: string[] = []
  const data = createAccountData({
    session: () => session,
    streams: async (_token, _clientId, language) => { calls.push(`streams:${language}`); return [stream(`live-in-${language}`)] },
    followed: async userId => { calls.push(`followed:${userId}`); return followed(`followed-by-${userId}`) },
    now: () => time,
    ...overrides
  })
  return {
    data, calls,
    signIn: (next: Partial<typeof session>) => { session = { ...session, ...next } },
    advance: (ms: number) => { time += ms }
  }
}

test('a list is fetched once, then served from the cache for a minute', async () => {
  const context = harness()
  assert.deepEqual((await context.data.streams('fr', false)).map(item => item.channel), ['live-in-fr'])
  await context.data.streams('fr', false)
  assert.deepEqual(context.calls, ['streams:fr'])

  // Each language keeps its own slot: a shared one would serve the wrong catalogue.
  await context.data.streams('en', false)
  assert.deepEqual(context.calls, ['streams:fr', 'streams:en'])

  context.advance(60_001)
  await context.data.streams('fr', false)
  assert.deepEqual(context.calls, ['streams:fr', 'streams:en', 'streams:fr'])
})

test('a refresh goes past the cache without waiting for it to expire', async () => {
  const context = harness()
  await context.data.followed(false)
  await context.data.followed(false)
  await context.data.followed(true)
  assert.deepEqual(context.calls, ['followed:1', 'followed:1'])
})

test('an account signed in during the call gets none of the previous one lists', async () => {
  // The whole reason this lives in its own module: the answer arrives after the switch, and
  // used to refill the emptied cache with somebody else's channels.
  const context: ReturnType<typeof harness> = harness({
    followed: async () => {
      context.signIn({ token: 'token-of-bob', userId: '2', generation: 2 })
      return followed('followed-by-alice')
    }
  })

  await assert.rejects(context.data.followed(false), error => errorKey(error) === 'authCancelled')
})

test('the list that was turned away is not left behind in the cache', async () => {
  // The assertion that matters. Rejecting is not enough: code that caches before throwing
  // passes the test above and still hands Alice's channels to Bob on the next call.
  let generation = 1
  const context: ReturnType<typeof harness> = harness({
    session: () => ({ token: 'token', clientId: 'client', userId: String(generation), follows: true, generation }),
    followed: async userId => {
      context.calls.push(`followed:${userId}`)
      if (userId === '1') generation = 2
      return followed(`followed-by-${userId}`)
    }
  })

  await assert.rejects(context.data.followed(false), error => errorKey(error) === 'authCancelled')
  const second = await context.data.followed(false)
  assert.deepEqual(second.live.map(item => item.channel), ['followed-by-2'])
  assert.deepEqual(context.calls, ['followed:1', 'followed:2'])
})

test('the lists go away with the account that owned them', async () => {
  const context = harness()
  await context.data.streams('fr', false)
  await context.data.followed(false)
  context.data.clear()

  await context.data.streams('fr', false)
  await context.data.followed(false)
  assert.deepEqual(context.calls, ['streams:fr', 'followed:1', 'streams:fr', 'followed:1'])
})

test('a session without the follows scope names the scope, not an expired session', async () => {
  const context = harness()
  // The token this account signed in with predates the followed view: it is alive — the catalog
  // answers on it — and Twitch would still turn the followed calls down with a 401.
  context.signIn({ follows: false })
  await assert.rejects(context.data.followed(false), error => errorKey(error) === 'twitchFollowedScope')
  assert.deepEqual((await context.data.streams('fr', false)).map(item => item.channel), ['live-in-fr'])
  assert.deepEqual(context.calls, ['streams:fr'])

  // Signing in again brings the scope, and with it the list: nothing stays cached from the refusal.
  context.signIn({ follows: true })
  assert.deepEqual((await context.data.followed(false)).live.map(item => item.channel), ['followed-by-1'])
})

test('without an account, neither list is even asked for', async () => {
  const context = harness()
  context.signIn({ token: null })
  await assert.rejects(context.data.streams('fr', false), error => errorKey(error) === 'needAccountForDiscover')
  await assert.rejects(context.data.followed(false), error => errorKey(error) === 'twitchFollowedReconnect')
  assert.deepEqual(context.calls, [])
})
