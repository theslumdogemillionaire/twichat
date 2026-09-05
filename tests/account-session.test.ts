import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAccountSession, type AccountSessionParts, type AuthResponse } from '../src/main/account-session'
import type { AccountCredentials } from '../src/main/accounts'
import { errorKey } from '../src/shared/errors'

/** Lets everything already in flight reach its next wait. */
const settle = () => new Promise(resolve => setImmediate(resolve))

/** A Twitch answer, reduced to what the session reads of one. */
function answer(status: number, body: unknown): AuthResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}
const validated = (login: string, expiresIn = 14_400) => answer(200, { login, client_id: `${login}-client`, user_id: '4242', scopes: ['chat:read', 'chat:edit'], expires_in: expiresIn })

/**
 * The application around the session, all of it recorded: what was written to the account file,
 * what the chat was told, which scope was loaded. Every network answer is queued by the test,
 * and `hold` keeps one in flight for as long as the interleaving needs.
 */
function harness(options: { saved?: Record<string, AccountCredentials>; preferred?: string | null } = {}) {
  const saved: Record<string, AccountCredentials> = options.saved ?? {}
  const calls: string[] = []
  let preferred = options.preferred ?? null
  const queued: Array<(url: string) => AuthResponse | Promise<AuthResponse>> = []
  let chatLogin: string | null = null

  const parts: AccountSessionParts = {
    accounts: {
      preferred: async () => preferred,
      credentials: async login => {
        const found = saved[String(login)]
        if (!found) throw new Error(`no account ${login}`)
        return found
      },
      save: async (login, accessToken, refreshToken) => { calls.push(`save:${login}:${accessToken}`); saved[String(login)] = { accessToken, refreshToken } },
      select: async login => { calls.push(`select:${login}`); preferred = String(login) },
      remove: async login => { calls.push(`remove:${login}`); delete saved[String(login)] }
    },
    chat: {
      login: () => chatLogin,
      connect: account => { calls.push(`connect:${account.login}:${account.token}`); chatLogin = account.login },
      renewToken: token => { calls.push(`renew:${token}`) },
      logout: reconnectAnonymously => { calls.push(`logout:${reconnectAnonymously}`); chatLogin = null }
    },
    fetch: async url => {
      const next = queued.shift()
      if (!next) throw new Error(`no answer queued for ${url}`)
      return next(url)
    },
    switchScope: async login => { calls.push(`scope:${login ?? 'anonymous'}`) },
    refreshRaidWatch: () => calls.push('raidwatch'),
    announce: outcome => calls.push(`announce:${outcome}`),
    rememberAvatar: async login => { calls.push(`avatar:${login}`) },
    forgetAvatar: async login => { calls.push(`forget-avatar:${login}`) },
    forgetPreferences: login => { calls.push(`forget-preferences:${login}`) },
    streams: async () => [],
    followed: async () => ({ live: [], offline: [], truncated: false }),
    // No appointment fires on its own: a renewal in these tests is one the test asked for.
    timers: { set: () => 0, clear: () => {} }
  }

  return {
    session: createAccountSession(parts),
    calls,
    saved,
    reply: (...answers: AuthResponse[]) => { for (const one of answers) queued.push(() => one) },
    /** Makes the preferences row refuse to go, the way a locked database would. */
    failForget: () => { parts.forgetPreferences = () => { throw new Error('database is locked') } },
    /** Queues an answer the test releases by hand, so a call can be caught mid-flight. */
    hold(response: AuthResponse) {
      let release = () => {}
      const held = new Promise<AuthResponse>(resolve => { release = () => resolve(response) })
      queued.push(() => held)
      return () => { release(); return settle() }
    }
  }
}

test('the saved account is taken back up at startup', async () => {
  const bench = harness({ preferred: 'alice', saved: { alice: { accessToken: 'alice-token' } } })
  bench.reply(validated('alice'))
  await bench.session.restore()
  assert.deepEqual(bench.calls, ['scope:alice', 'connect:alice:alice-token', 'avatar:alice', 'raidwatch'])
  assert.equal(bench.session.credentials().token, 'alice-token')
  assert.equal(bench.session.credentials().clientId, 'alice-client')
})

test('nothing is taken back up when no account asked to be', async () => {
  const bench = harness({ preferred: null })
  await bench.session.restore()
  assert.deepEqual(bench.calls, [])
})

test('a token Twitch refuses is renewed, and the renewal saved', async () => {
  const bench = harness({ preferred: 'alice', saved: { alice: { accessToken: 'stale', refreshToken: 'refresh-1' } } })
  bench.reply(answer(401, {}), answer(200, { accessToken: 'fresh', refreshToken: 'refresh-2' }), validated('alice'))
  await bench.session.restore()
  assert.equal(bench.session.credentials().token, 'fresh')
  assert.deepEqual(bench.saved.alice, { accessToken: 'fresh', refreshToken: 'refresh-2' })
  assert.ok(bench.calls.includes('connect:alice:fresh'))
})

test('an account Twitch refuses twice is dropped, and nothing of it is left behind', async () => {
  const bench = harness({ preferred: 'alice', saved: { alice: { accessToken: 'stale', refreshToken: 'refresh-1' } } })
  bench.reply(answer(401, {}), answer(200, { accessToken: 'fresh', refreshToken: 'refresh-2' }), answer(401, {}))
  await bench.session.restore()
  // The credentials, the cached face and the rooms and settings the account had: all three, in
  // that order. Signing out keeps every one of them — this is the path that must not.
  assert.deepEqual(bench.calls.filter(call => /^(remove|forget-)/.test(call)), ['remove:alice', 'forget-avatar:alice', 'forget-preferences:alice'])
  assert.equal(bench.session.credentials().token, null)
})

test('a store that refuses to give up a row still gives up the token', async () => {
  const bench = harness({ saved: { alice: { accessToken: 'alice-token' } } })
  bench.failForget()
  bench.reply(validated('mallory'))
  await assert.rejects(bench.session.useSaved('alice'), error => errorKey(error) === 'tokenMismatch')
  // A disk that will not let the preferences go must not leave the application holding a token
  // Twitch has already refused.
  assert.ok(bench.calls.includes('remove:alice'))
})

test('a startup restore landing after another account signed in connects nobody', async () => {
  const bench = harness({ preferred: 'alice', saved: { alice: { accessToken: 'alice-token' } } })
  // Alice's validation leaves, and stays out: the session gate is still on screen.
  const releaseAlice = bench.hold(validated('alice'))
  const restoring = bench.session.restore()
  await settle()
  // Bob is pasted into that gate and answers at once.
  bench.reply(validated('bob'))
  assert.equal(await bench.session.authenticate('bob-token'), 'bob')
  await releaseAlice()
  await restoring

  assert.equal(bench.session.credentials().token, 'bob-token', 'Alice came back and took the session')
  assert.equal(bench.calls.filter(call => call.startsWith('connect:')).length, 1)
  assert.ok(!bench.calls.includes('connect:alice:alice-token'))
  assert.ok(!bench.calls.some(call => call.startsWith('logout')))
  assert.ok(!bench.calls.includes('scope:alice'))
})

test('a chooser pick landing after another connects nobody', async () => {
  const bench = harness({ saved: { alice: { accessToken: 'alice-token' }, bob: { accessToken: 'bob-token' } } })
  const releaseAlice = bench.hold(validated('alice'))
  const picking = bench.session.useSaved('alice')
  // The assertion is attached before Alice comes back: her refusal must not pass for an
  // unhandled rejection on the way.
  const abandoned = assert.rejects(picking, error => errorKey(error) === 'authCancelled')
  await settle()
  bench.reply(validated('bob'))
  await bench.session.useSaved('bob')
  await releaseAlice()
  await abandoned
  assert.equal(bench.session.credentials().token, 'bob-token')
  assert.ok(!bench.calls.includes('select:alice'))
})

test('a browser sign-in landing after a sign-out connects nobody', async () => {
  const bench = harness()
  const opened = bench.session.nextGeneration()
  const releaseClaim = bench.hold(answer(200, { accessToken: 'browser-token', refreshToken: 'browser-refresh' }))
  const claiming = bench.session.claim('a'.repeat(43), 'verifier', opened)
  const abandoned = assert.rejects(claiming, error => errorKey(error) === 'authCancelled')
  // Twitch still answers the validation that follows the exchange: the sign-out is what stops it.
  bench.reply(validated('carol'))
  await settle()
  bench.session.logout()
  await releaseClaim()
  await abandoned
  assert.equal(bench.session.credentials().token, null)
  assert.equal(bench.calls.filter(call => call.startsWith('connect:')).length, 0)
})

test('a browser sign-in nobody interrupted connects the account it names', async () => {
  const bench = harness()
  const opened = bench.session.nextGeneration()
  bench.reply(answer(200, { accessToken: 'browser-token', refreshToken: 'browser-refresh' }), validated('carol'))
  assert.equal(await bench.session.claim('a'.repeat(43), 'verifier', opened), 'carol')
  assert.deepEqual(bench.saved.carol, { accessToken: 'browser-token', refreshToken: 'browser-refresh' })
  assert.ok(bench.calls.includes('connect:carol:browser-token'))
})

test('the exchange server names the error the user reads', async () => {
  const bench = harness()
  bench.reply(answer(400, { key: 'authDeviceMismatch' }))
  await assert.rejects(bench.session.claim('a'.repeat(43), 'verifier', bench.session.generation()), error => errorKey(error) === 'authDeviceMismatch')
})

test('signing out empties the credentials and goes back to the anonymous scope', async () => {
  const bench = harness({ preferred: 'alice', saved: { alice: { accessToken: 'alice-token' } } })
  bench.reply(validated('alice'))
  await bench.session.restore()
  const before = bench.session.generation()
  bench.session.logout(false)
  await settle()
  assert.equal(bench.session.credentials().token, null)
  assert.equal(bench.session.generation(), before + 1)
  assert.ok(bench.calls.includes('logout:false'))
  assert.ok(bench.calls.includes('scope:anonymous'))
})

test('a token without the chat scopes is refused, and the account dropped', async () => {
  const bench = harness({ saved: { alice: { accessToken: 'alice-token' } } })
  bench.reply(answer(200, { login: 'alice', client_id: 'alice-client', user_id: '1', scopes: ['chat:read'] }))
  await assert.rejects(bench.session.useSaved('alice'), error => errorKey(error) === 'tokenScopes')
  assert.ok(bench.calls.includes('remove:alice'))
})

test('a token naming another account than the one picked is refused', async () => {
  const bench = harness({ saved: { alice: { accessToken: 'alice-token' } } })
  bench.reply(validated('mallory'))
  await assert.rejects(bench.session.useSaved('alice'), error => errorKey(error) === 'tokenMismatch')
  assert.equal(bench.session.credentials().token, null)
})

test('a renewal changes the token in place, without rejoining a single room', async () => {
  const bench = harness({ saved: { alice: { accessToken: 'alice-token', refreshToken: 'refresh-1' } } })
  bench.reply(validated('alice'))
  await bench.session.useSaved('alice')
  // The appointment lands in the last minutes of the token: the exchange happens, and the chat
  // socket — which checked its password once, when it connected — is told the new one.
  bench.reply(validated('alice', 120), answer(200, { accessToken: 'fresh', refreshToken: 'refresh-2' }), validated('alice'))
  assert.equal(await bench.session.check(), true)
  assert.equal(bench.session.credentials().token, 'fresh')
  assert.deepEqual(bench.saved.alice, { accessToken: 'fresh', refreshToken: 'refresh-2' })
  assert.ok(bench.calls.includes('renew:fresh'))
  assert.ok(bench.calls.includes('announce:renewed'))
  assert.equal(bench.calls.filter(call => call.startsWith('connect:')).length, 1, 'the renewal rejoined the rooms')
})

test('a session found alive renews nothing', async () => {
  const bench = harness({ saved: { alice: { accessToken: 'alice-token', refreshToken: 'refresh-1' } } })
  bench.reply(validated('alice'))
  await bench.session.useSaved('alice')
  bench.reply(validated('alice'))
  assert.equal(await bench.session.check(), false)
  assert.equal(bench.session.credentials().token, 'alice-token')
  assert.ok(!bench.calls.some(call => call.startsWith('renew:')))
})

test('the discovery lists are emptied when the account changes', async () => {
  const bench = harness({ saved: { alice: { accessToken: 'alice-token' } } })
  bench.reply(validated('alice'))
  await bench.session.useSaved('alice')
  assert.deepEqual(await bench.session.data.streams('fr', false), [])
  bench.session.logout()
  await assert.rejects(bench.session.data.streams('fr', false), error => errorKey(error) === 'needAccountForDiscover')
})
