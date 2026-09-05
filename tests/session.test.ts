import test from 'node:test'
import assert from 'node:assert/strict'
import { AppError } from '../src/shared/errors'
import { createSessionGuard, dueForRenewal, InvalidTokenError, nextCheckDelay, type SessionParts, type ValidatedToken } from '../src/main/session'

function validated(overrides: Partial<ValidatedToken> = {}): ValidatedToken {
  return { login: 'alice', clientId: 'client-id', userId: '1', follows: true, expiresIn: 14400, ...overrides }
}

/**
 * A guard wired to answers the test writes itself, and to a clock that never ticks on its own:
 * what is under test is the order of the awaits, not the passing of time.
 */
function harness(parts: Partial<SessionParts> = {}) {
  const log: string[] = []
  const delays: number[] = []
  let state = { token: 'token-one' as string | null, login: 'alice' as string | null, refreshToken: 'refresh-one' as string | null, generation: 1 }
  const guard = createSessionGuard({
    snapshot: () => state,
    validate: async () => validated(),
    renew: async () => ({ accessToken: 'token-two', refreshToken: 'refresh-two' }),
    remember: async (login, credentials) => { log.push(`remember:${login}:${credentials.accessToken}`) },
    forget: async login => { log.push(`forget:${login}`) },
    adopt: credentials => {
      log.push(`adopt:${credentials.accessToken}`)
      state = { ...state, token: credentials.accessToken, refreshToken: credentials.refreshToken ?? null }
    },
    logout: () => { log.push('logout') },
    announce: outcome => { log.push(`announce:${outcome}`) },
    timers: { set: (_callback, delay) => { delays.push(delay); return delays.length }, clear: () => {} },
    ...parts
  })
  return { guard, log, delays, signIn: (next: Partial<typeof state>) => { state = { ...state, ...next } } }
}

test('a token near its end is exchanged, not merely looked at again', () => {
  // The appointment used to land early and do nothing with it: a validation that answered
  // "still valid" only booked the next validation, and the token was replaced after Twitch
  // refused it rather than before.
  assert.equal(dueForRenewal(200), true)
  assert.equal(dueForRenewal(5 * 60), true)
  assert.equal(dueForRenewal(3600), false)
  // A token that announces nothing is on the hourly schedule and is renewed by nothing.
  for (const value of [0, -1, undefined, null, NaN, 'soon']) assert.equal(dueForRenewal(value), false)
})

test('a session is checked within the hour Twitch asks for, whatever the token announces', () => {
  // Twitch wants a validation at startup and every hour after that. A four-hour token used to
  // book its next look nearly four hours out, well past that contract.
  assert.equal(nextCheckDelay(14400), 60 * 60 * 1000)
  assert.equal(nextCheckDelay(3600), (3600 - 300) * 1000)
  // The margin shrinks with the token instead of outliving it.
  assert.equal(nextCheckDelay(600), (600 - 150) * 1000)
  for (const value of [0, -1, undefined, null, NaN, 'soon']) assert.equal(nextCheckDelay(value), 60 * 60 * 1000)
  // An expiry already reached must not turn the appointment into a loop of calls.
  assert.equal(nextCheckDelay(5), 30_000)
})

test('the appointment before the expiry actually renews the session', async () => {
  let call = 0
  const context = harness({ validate: async () => validated({ expiresIn: ++call === 1 ? 120 : 14400 }) })

  assert.equal(await context.guard.check(), true)
  assert.deepEqual(context.log, ['remember:alice:token-two', 'adopt:token-two', 'announce:renewed'])
  // The renewed token books its own look within the hour.
  assert.equal(context.delays.at(-1), 60 * 60 * 1000)
})

test('a token with hours left is left alone and looked at again later', async () => {
  const context = harness()
  assert.equal(await context.guard.check(), false)
  assert.deepEqual(context.log, [])
  assert.equal(context.delays.at(-1), 60 * 60 * 1000)
})

test('an account signed in during a renewal is not signed out by it', async () => {
  // The renewal opened on Alice and comes back while Bob is connected: it used to fall into a
  // single catch, forget Alice and sign Bob out, without ever looking at who was there.
  const context: ReturnType<typeof harness> = harness({
    validate: async () => { throw new InvalidTokenError('tokenRejected') },
    renew: async () => {
      context.signIn({ token: 'token-of-bob', login: 'bob', refreshToken: 'refresh-of-bob', generation: 2 })
      throw new AppError('authRefreshRejected')
    }
  })

  assert.equal(await context.guard.check(), false)
  assert.deepEqual(context.log, [])
})

test('a renewal nobody answered keeps the account and tries again shortly', async () => {
  // A sign-in server that timed out was read as a revocation, and the saved account was deleted.
  const context = harness({
    validate: async () => { throw new InvalidTokenError('tokenRejected') },
    renew: async () => { throw new AppError('authServerUnresponsive') }
  })

  assert.equal(await context.guard.check(), false)
  assert.deepEqual(context.log, [])
  assert.equal(context.delays.at(-1), 60_000)
})

test('a renewal refused while the token still lives keeps the account', async () => {
  const context = harness({
    validate: async () => validated({ expiresIn: 120 }),
    renew: async () => { throw new AppError('authRefreshRejected') }
  })

  assert.equal(await context.guard.check(), false)
  assert.deepEqual(context.log, [])
  assert.equal(context.delays.at(-1), 60_000)
})

test('a refused token that cannot be renewed ends the session', async () => {
  const context = harness({
    validate: async () => { throw new InvalidTokenError('tokenRejected') },
    renew: async () => { throw new AppError('authRefreshRejected') }
  })

  assert.equal(await context.guard.check(), false)
  assert.deepEqual(context.log, ['forget:alice', 'logout', 'announce:expired'])
})

test('a renewal that comes back as another account renews nothing', async () => {
  const context = harness({
    validate: async (token: string) => {
      if (token === 'token-one') throw new InvalidTokenError('tokenRejected')
      return validated({ login: 'bob' })
    }
  })

  assert.equal(await context.guard.check(), false)
  // The token was saved for nobody, and the session it did not match is the one dropped.
  assert.deepEqual(context.log, ['forget:alice', 'logout', 'announce:expired'])
})

test('two calls proving the same dead token spend one renewal', async () => {
  let renewals = 0
  const context = harness({
    validate: async () => { throw new InvalidTokenError('tokenRejected') },
    renew: async () => { renewals++; return { accessToken: 'token-two', refreshToken: 'refresh-two' } }
  })

  await Promise.all([context.guard.check(), context.guard.check()])
  assert.equal(renewals, 1)
})

test('a disk that refuses to forget still ends the session', async () => {
  const context = harness({
    validate: async () => { throw new InvalidTokenError('tokenRejected') },
    renew: async () => { throw new AppError('authRefreshRejected') },
    forget: async () => { throw new Error('read-only volume') }
  })

  assert.equal(await context.guard.check(), false)
  // The account may survive on disk; the application must not keep talking with a refused token.
  assert.deepEqual(context.log, ['logout', 'announce:expired'])
})
