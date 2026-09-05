import { AppError, errorKey, type ErrorKey } from '../shared/errors'
import type { AccountCredentials } from './accounts'

/** A rejected token: a catalog error like any other, so it crosses the IPC with its key. */
export class InvalidTokenError extends AppError {}

export interface ValidatedToken { login: string; clientId: string; userId: string; follows: boolean; expiresIn: number }

/** Twitch asks for a validation at startup, then once an hour, whatever the token announces. */
const VALIDATION_INTERVAL = 60 * 60 * 1000
/** Below this much life left, the token is renewed rather than merely validated once more. */
const RENEWAL_MARGIN = 5 * 60
/** A renewal that did not go through is tried again shortly, never left for the hourly check. */
const RETRY_DELAY = 60_000

/**
 * When to look at a token again, knowing it announced `expiresIn` seconds of life.
 *
 * Two deadlines meet here. Twitch wants a validation every hour, and a token dies without the
 * chat noticing: the IRC socket checks its PASS at connection only, so the account keeps talking
 * while every Helix and EventSub call answers 401. The check therefore lands on whichever comes
 * first — the hour, or the few minutes before the announced expiry, where `dueForRenewal` takes
 * over. A token that announces nothing — the ones granted before Twitch dated them — only ever
 * gets the hour.
 */
export function nextCheckDelay(expiresIn: unknown) {
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) return VALIDATION_INTERVAL
  // A quarter of a short life, five minutes of a long one: the margin never outgrows the token.
  const margin = Math.min(RENEWAL_MARGIN, expiresIn / 4)
  return Math.min(VALIDATION_INTERVAL, Math.max(30_000, Math.round((expiresIn - margin) * 1000)))
}

/**
 * Whether a token this close to its end must be exchanged now. A validation that answers "still
 * valid" renews nothing by itself: without this, the early appointment only ever moved the next
 * appointment, and the session was replaced after Twitch refused it rather than before.
 */
export function dueForRenewal(expiresIn: unknown) {
  return typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0 && expiresIn <= RENEWAL_MARGIN
}

/** The failures that end a session, as opposed to a road to Twitch that happens to be out. */
const DEFINITIVE = new Set<ErrorKey>(['authRefreshInvalid', 'authRefreshRejected', 'tokenRejected', 'tokenScopes', 'tokenRenewedMismatch'])
function definitive(error: unknown) {
  const key = errorKey(error)
  return key !== null && DEFINITIVE.has(key)
}

export interface SessionTimers {
  set(callback: () => void, delay: number): unknown
  clear(handle: unknown): void
}

export interface SessionParts {
  /**
   * The session a check opens on. Every answer is compared against this before it is used, so
   * this must read the state afresh and hand back a copy — never a handle onto it.
   */
  snapshot(): { token: string | null; login: string | null; refreshToken: string | null; generation: number }
  validate(token: string): Promise<ValidatedToken>
  renew(refreshToken: string): Promise<AccountCredentials>
  remember(login: string, credentials: AccountCredentials): Promise<void>
  forget(login: string): Promise<void>
  adopt(credentials: AccountCredentials, validated: ValidatedToken): void
  logout(): void
  announce(outcome: 'renewed' | 'expired'): void
  timers?: SessionTimers
}

/**
 * Keeps the Twitch session alive: renews it before Twitch drops it, and again whenever a call
 * proves it already has.
 *
 * Everything here waits on the network, and the account can change under a wait — a sign-out, a
 * second account chosen in the chooser. The generation taken at the start is checked after each
 * one: a check that comes back into another session abandons quietly rather than saving its
 * token over the new one, or signing the new account out.
 */
export function createSessionGuard(parts: SessionParts) {
  const timers = parts.timers ?? {
    set: (callback: () => void, delay: number) => setTimeout(callback, delay),
    clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>)
  }
  let timer: unknown = null
  // One renewal at a time: a token dies for every call at once, and each 401 must not spend the
  // renewal session again.
  let running: Promise<boolean> | null = null

  function scheduleIn(delay: number) {
    stop()
    timer = timers.set(() => void check(), delay)
  }
  function schedule(expiresIn: number) { scheduleIn(nextCheckDelay(expiresIn)) }
  function stop() {
    if (timer !== null) timers.clear(timer)
    timer = null
  }

  /** Answers whether a renewal was adopted — a session found intact renews nothing. */
  function check() {
    running ??= run().finally(() => { running = null })
    return running
  }

  async function run(): Promise<boolean> {
    const opened = parts.snapshot()
    if (!opened.token || !opened.login) return false
    const moved = () => {
      const now = parts.snapshot()
      return now.generation !== opened.generation || now.token !== opened.token
    }

    // Whether Twitch itself refused the token, as opposed to it merely nearing its end.
    let rejected = false
    try {
      const validated = await parts.validate(opened.token)
      if (moved()) return false
      // Comfortably alive: nothing is spent, only the next appointment moves.
      if (!dueForRenewal(validated.expiresIn)) { schedule(validated.expiresIn); return false }
    } catch (error) {
      if (moved()) return false
      // Twitch unreachable says nothing about the token: it is rechecked, not condemned.
      if (!(error instanceof InvalidTokenError)) { scheduleIn(VALIDATION_INTERVAL); return false }
      rejected = true
    }

    if (opened.refreshToken) {
      try {
        const renewed = await parts.renew(opened.refreshToken)
        if (moved()) return false
        const validated = await parts.validate(renewed.accessToken)
        if (moved()) return false
        if (validated.login !== opened.login) throw new InvalidTokenError('tokenRenewedMismatch')
        await parts.remember(opened.login, renewed)
        if (moved()) return false
        parts.adopt(renewed, validated)
        schedule(validated.expiresIn)
        parts.announce('renewed')
        return true
      } catch (error) {
        if (moved()) return false
        // A refusal ends the session, but only once Twitch has also refused the token itself.
        // A timeout, a 5xx, a renewal turned down while the token still has minutes to live:
        // the account stays, and the exchange is tried again shortly.
        if (!rejected || !definitive(error)) { scheduleIn(RETRY_DELAY); return false }
      }
    } else if (!rejected) {
      // Nothing to renew with, and a token still alive: its rejection is what ends the session.
      scheduleIn(RETRY_DELAY)
      return false
    }

    // Forgetting is best effort: a disk that refuses must not leave the application holding a
    // token Twitch has already refused.
    await parts.forget(opened.login).catch(() => {})
    if (moved()) return false
    parts.logout()
    parts.announce('expired')
    return false
  }

  return { schedule, stop, check }
}
