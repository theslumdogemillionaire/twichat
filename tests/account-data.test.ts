import test from 'node:test'
import assert from 'node:assert/strict'
import { createAccountData, type AccountDataParts } from '../src/main/account-data'
import { errorKey } from '../src/shared/errors'
import type { FollowedChannels, StreamSummary } from '../src/shared/types'

const stream = (channel: string): StreamSummary => ({
  id: channel, channel, displayName: channel, avatarUrl: '', thumbnailUrl: '',
  title: '', game: '', gameId: '', viewers: 1, tags: [], language: 'fr', startedAt: ''
})
const followed = (login: string): FollowedChannels => ({ live: [stream(login)], offline: [], truncated: false })

/** A session the test moves, and calls it can answer whenever it likes. */
function harness(overrides: Partial<AccountDataParts> = {}) {
  let session = { token: 'token-of-alice' as string | null, clientId: 'client', userId: '1' as string | null, follows: true, blocks: true, generation: 1 }
  let time = 1_000_000
  const calls: string[] = []
  const data = createAccountData({
    session: () => session,
    streams: async (_token, _clientId, language, gameId, after) => {
      calls.push(`streams:${gameId ? `${gameId}@` : ''}${language}${after ? `+${after}` : ''}`)
      return { streams: [stream(`live-in-${gameId ? `${gameId}-` : ''}${language}${after ? `-${after}` : ''}`)], cursor: after ? '' : 'page2' }
    },
    followed: async userId => { calls.push(`followed:${userId}`); return followed(`followed-by-${userId}`) },
    search: async query => { calls.push(`search:${query}`); return { live: [stream(`found-for-${query}`)], offline: [] } },
    searchCategories: async query => { calls.push(`categories:${query}`); return [{ id: '1', name: `category-for-${query}`, boxArtUrl: '' }] },
    topCategories: async (_token, _clientId, after) => {
      calls.push(`top-categories${after ? `+${after}` : ''}`)
      return { categories: [{ id: after ? '32982' : '509658', name: 'Just Chatting', boxArtUrl: '' }], cursor: after ? '' : 'page2' }
    },
    blocked: async userId => { calls.push(`blocked:${userId}`); return [{ login: `blocked-by-${userId}`, userId: '9', displayName: 'Blocked' }] },
    block: async targetId => { calls.push(`block:${targetId}`) },
    unblock: async targetId => { calls.push(`unblock:${targetId}`) },
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
  assert.deepEqual((await context.data.streams('fr', false)).streams.map(item => item.channel), ['live-in-fr'])
  await context.data.streams('fr', false)
  assert.deepEqual(context.calls, ['streams:fr'])

  // Each language keeps its own slot: a shared one would serve the wrong catalogue.
  await context.data.streams('en', false)
  assert.deepEqual(context.calls, ['streams:fr', 'streams:en'])

  context.advance(60_001)
  await context.data.streams('fr', false)
  assert.deepEqual(context.calls, ['streams:fr', 'streams:en', 'streams:fr'])
})

test('a category is a catalogue of its own, kept apart from the one it was opened from', async () => {
  const context = harness()
  await context.data.streams('fr', false)
  // Twitch narrows on the category and the language together, so an answer belongs to both. Under
  // the language alone this second call would have been served the whole catalogue back.
  assert.deepEqual((await context.data.streams('fr', false, '509658')).streams.map(item => item.channel), ['live-in-509658-fr'])
  assert.deepEqual(context.calls, ['streams:fr', 'streams:509658@fr'])
  await context.data.streams('fr', false, '509658')
  assert.deepEqual((await context.data.streams('fr', false)).streams.map(item => item.channel), ['live-in-fr'])
  assert.deepEqual(context.calls, ['streams:fr', 'streams:509658@fr'])

  // The same category in another language is another list: Twitch answers it differently.
  await context.data.streams('en', false, '509658')
  assert.deepEqual(context.calls, ['streams:fr', 'streams:509658@fr', 'streams:509658@en'])
})

test('the two halves of the search box are asked and kept apart', async () => {
  const context = harness({
    // Twitch turning the categories down is its own answer: the channels it found stand.
    searchCategories: async query => { throw new Error(`no categories for ${query}`) }
  })
  assert.deepEqual((await context.data.search('speedrun')).live.map(item => item.channel), ['found-for-speedrun'])
  await assert.rejects(context.data.searchCategories('speedrun'))
  // The refusal was not written down: the next look asks again rather than serving an empty row.
  await assert.rejects(context.data.searchCategories('speedrun'))

  const kept = harness()
  await kept.data.searchCategories('speedrun')
  await kept.data.searchCategories('SpeedRun')
  await kept.data.search('speedrun')
  // One call each, and the case folds into the same key — but a category answer never stands in
  // for a channel one.
  assert.deepEqual(kept.calls, ['categories:speedrun', 'search:speedrun'])
})

test('a page is cached under the cursor it was asked by, and a refresh drops the whole walk', async () => {
  const context = harness()
  const first = await context.data.streams('fr', false)
  assert.equal(first.cursor, 'page2')
  const second = await context.data.streams('fr', false, '', 'page2')
  assert.deepEqual(second.streams.map(item => item.channel), ['live-in-fr-page2'])
  // Twitch says nothing comes after: the window stops asking.
  assert.equal(second.cursor, '')
  assert.deepEqual(context.calls, ['streams:fr', 'streams:fr+page2'])
  // Both pages are held, so scrolling back through them costs nothing.
  await context.data.streams('fr', false)
  await context.data.streams('fr', false, '', 'page2')
  assert.equal(context.calls.length, 2)

  // A refresh asks for the ranking as it stands now — and the pages cut from the one before it go
  // with it. Served next to a fresh first page they would card the same channel twice.
  await context.data.streams('fr', true)
  await context.data.streams('fr', false, '', 'page2')
  assert.deepEqual(context.calls, ['streams:fr', 'streams:fr+page2', 'streams:fr', 'streams:fr+page2'])
})

test('the categories walk their own pages, and forget them on a refresh the same way', async () => {
  const context = harness()
  const first = await context.data.topCategories(false)
  assert.deepEqual(first.categories.map(row => row.id), ['509658'])
  assert.equal(first.cursor, 'page2')
  assert.deepEqual((await context.data.topCategories(false, 'page2')).categories.map(row => row.id), ['32982'])
  await context.data.topCategories(false, 'page2')
  assert.deepEqual(context.calls, ['top-categories', 'top-categories+page2'])
  await context.data.topCategories(true)
  await context.data.topCategories(false, 'page2')
  assert.deepEqual(context.calls, ['top-categories', 'top-categories+page2', 'top-categories', 'top-categories+page2'])
})

test('browsing category after category cannot grow the cache without end', async () => {
  const context = harness()
  // There are eight languages and thousands of categories: without a ceiling this map would keep
  // one entry per category visited for as long as the session lasts.
  for (let index = 0; index < 25; index++) await context.data.streams('fr', false, String(index))
  assert.equal(context.calls.length, 25)
  // The twenty most recent are still there; the five oldest were dropped to make room.
  await context.data.streams('fr', false, '24')
  assert.equal(context.calls.length, 25)
  await context.data.streams('fr', false, '0')
  assert.deepEqual(context.calls.at(-1), 'streams:0@fr')
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
    session: () => ({ token: 'token', clientId: 'client', userId: String(generation), follows: true, blocks: true, generation }),
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
  assert.deepEqual((await context.data.streams('fr', false)).streams.map(item => item.channel), ['live-in-fr'])
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

test('the blocked list is read once, kept, and answers the question a message asks', async () => {
  const context = harness()
  const users = await context.data.blocked()
  assert.deepEqual(users.map(user => user.login), ['blocked-by-1'])
  await context.data.blocked()
  assert.deepEqual(context.calls, ['blocked:1'])
  // A chat line carries a login, and the answer has to be there before the line is: no promise.
  assert.equal(context.data.isBlocked('blocked-by-1'), true)
  assert.equal(context.data.isBlocked('somebody-else'), false)
})

test('a token that predates the blocking scopes says so, and hides nobody', async () => {
  const context = harness()
  context.signIn({ blocks: false })
  await assert.rejects(context.data.blocked(), error => errorKey(error) === 'blocksScopeMissing')
  assert.deepEqual(context.calls, [])
  // Nothing was read, so nothing is hidden: the messages go through rather than half of them.
  assert.equal(context.data.isBlocked('blocked-by-1'), false)
})

test('the eager load is what makes the filter work at all, and it is silent', async () => {
  const context = harness()
  context.data.preloadBlocked()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(context.data.isBlocked('blocked-by-1'), true)

  // Without the scope it asks for nothing rather than failing where nobody is listening.
  const scopeless = harness()
  scopeless.signIn({ blocks: false })
  scopeless.data.preloadBlocked()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(scopeless.calls, [])
})

test('the list an account was blocked under does not filter the next account messages', async () => {
  // The worst bug available here: one account's blocks going on hiding people from another's
  // rooms — or, the other way round, its blocked people reappearing under it.
  const context = harness()
  await context.data.blocked()
  assert.equal(context.data.isBlocked('blocked-by-1'), true)
  context.data.clear()
  assert.equal(context.data.isBlocked('blocked-by-1'), false)
})

test('a list that came back after the account changed is refused rather than adopted', async () => {
  let generation = 1
  const context: ReturnType<typeof harness> = harness({
    session: () => ({ token: 'token', clientId: 'client', userId: String(generation), follows: true, blocks: true, generation }),
    blocked: async userId => {
      context.calls.push(`blocked:${userId}`)
      if (userId === '1') generation = 2
      return [{ login: `blocked-by-${userId}`, userId: '9', displayName: 'Blocked' }]
    }
  })
  await assert.rejects(context.data.blocked(), error => errorKey(error) === 'authCancelled')
  // And the set was not written either: the second account must not inherit the filter.
  assert.equal(context.data.isBlocked('blocked-by-1'), false)
  const second = await context.data.blocked()
  assert.deepEqual(second.map(user => user.login), ['blocked-by-2'])
  assert.equal(context.data.isBlocked('blocked-by-2'), true)
})

test('blocking re-reads the list rather than guessing what Twitch did with it', async () => {
  // Twitch answers 204 whether the block took or was already there, so its own answer about the
  // list is the only one worth believing.
  const context = harness()
  await context.data.setBlocked('9', true)
  assert.deepEqual(context.calls, ['block:9', 'blocked:1'])
  await context.data.setBlocked('9', false)
  assert.deepEqual(context.calls, ['block:9', 'blocked:1', 'unblock:9', 'blocked:1'])

  context.signIn({ blocks: false })
  await assert.rejects(context.data.setBlocked('9', true), error => errorKey(error) === 'blocksScopeMissing')
})
