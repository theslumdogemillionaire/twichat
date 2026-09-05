import { fail, isErrorKey } from '../shared/errors'
import { channelName } from '../shared/validation'
import type { AccountCredentials } from './accounts'
import { createAccountData, type AccountDataParts } from './account-data'
import { createSessionGuard, InvalidTokenError, type SessionTimers, type ValidatedToken } from './session'

/** Only what the exchange and the validation read of an answer: a test hands back a plain object. */
export interface AuthResponse { ok: boolean; status: number; json(): Promise<unknown> }
type Fetch = (url: string, init?: RequestInit) => Promise<AuthResponse>

/**
 * The chat socket, seen from the session. It matters here for one reason: the socket checks its
 * password when it connects and never again, so a renewal changes the token on it in place
 * instead of rejoining every room.
 */
export interface AccountChat {
  login(): string | null
  connect(account: { login: string; token: string }): void
  renewToken(token: string): void
  logout(reconnectAnonymously: boolean): void
}

/**
 * What the session needs of the account file. `AccountStore` satisfies it; a test hands over a
 * map, and the whole sign-in runs without a keychain.
 */
export interface AccountRecords {
  preferred(): Promise<string | null | undefined>
  credentials(login: unknown): Promise<AccountCredentials>
  save(login: unknown, accessToken: string, refreshToken?: string): Promise<unknown>
  select(login: unknown): Promise<unknown>
  remove(login: unknown): Promise<unknown>
}

export interface AccountSessionParts {
  accounts: AccountRecords
  chat: AccountChat
  /** Twitch's validation endpoint and the exchange server: `net.fetch` in the application. */
  fetch: Fetch
  /** Loads what the account owns — rooms, sizes, quality, theme, window. `null` is anonymous. */
  switchScope(login: string | null): Promise<void>
  /** The raid subscription authenticates as the account: it is remade on every change. */
  refreshRaidWatch(): void
  /** The line the chat shows when the session was renewed, or ended. */
  announce(outcome: 'renewed' | 'expired'): void
  /** Caches the account's profile picture, so the chooser draws before any Twitch call. */
  rememberAvatar(login: string, auth: { token: string; clientId: string }): Promise<void>
  /** Drops that cached picture, so the chooser never shows an orphaned face. */
  forgetAvatar(login: string): Promise<void>
  /** Drops what the account had set — rooms, sizes, quality, theme — and the pointer to it. */
  forgetPreferences(login: string): void
  streams: AccountDataParts['streams']
  followed: AccountDataParts['followed']
  now?: AccountDataParts['now']
  timers?: SessionTimers
}

/**
 * The Twitch account, whole: the credentials, what is done to obtain them, and everything that
 * has to move when they change.
 *
 * It lives in a module of its own because of what it is made of. Five values — token, refresh
 * token, client id, user id, generation — that a dozen places used to read and write as
 * module-level `let`s in `index.ts`, next to the windows and the menus. Nothing could be tested
 * without an Electron window, and the races are precisely here: an account signed in while
 * another's validation is still in flight, a renewal landing after a sign-out. The generation is
 * the answer to those, and it only works as one if a single counter serves every path — which is
 * why `nextGeneration` is exposed rather than left to a caller keeping its own.
 *
 * What the application brings — the chat, the stores, the scope, the network — comes in through
 * the parts, so the whole thing runs in a test.
 */
export function createAccountSession(parts: AccountSessionParts) {
  let token: string | null = null
  let refreshToken: string | null = null
  let clientId: string | null = null
  let userId: string | null = null
  // Twitch answers 401 to `channels/followed` for a token without `user:read:follows`, exactly as
  // it does for a dead one. The validation already lists the scopes: read there rather than guess
  // from a status code, and a session opened before that view existed says so instead of claiming
  // it expired.
  let follows = false
  let generation = 0

  /** What Twitch is streaming, and what the account follows: cached, and dropped with the account. */
  const data = createAccountData({
    session: () => ({ token, clientId, userId, follows, generation }),
    streams: parts.streams,
    followed: parts.followed,
    now: parts.now
  })

  async function validate(candidate: string): Promise<ValidatedToken> {
    const response = await parts.fetch('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: `OAuth ${candidate}` }, signal: AbortSignal.timeout(10000) })
    if (response.status === 401) throw new InvalidTokenError('tokenRejected')
    if (!response.ok) fail('tokenCheckUnavailable')
    const result = await response.json() as { login?: string; client_id?: string; user_id?: string; scopes?: string[]; expires_in?: number }
    if (!result.login || !result.client_id || !['chat:read', 'chat:edit'].every(scope => result.scopes?.includes(scope))) throw new InvalidTokenError('tokenScopes')
    // `user_id` comes from the same response: followed channels never pay for a call to get it.
    const id = String(result.user_id ?? '')
    // Twitch dates the token here and nowhere else: without it the renewal has only the clock.
    return {
      login: channelName(result.login), clientId: result.client_id, userId: /^\d{1,30}$/.test(id) ? id : '',
      follows: !!result.scopes?.includes('user:read:follows'), expiresIn: result.expires_in ?? 0
    }
  }

  function authServer() {
    const url = new URL(process.env.TWICHAT_AUTH_SERVER ?? 'https://twichat.theslumdogemillionaire.com')
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) fail('authServerHttps')
    return url.origin
  }

  async function backendJson(path: string, body: Record<string, string>) {
    const response = await parts.fetch(`${authServer()}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000)
    })
    const result = await response.json().catch(() => ({})) as Record<string, unknown>
    // The server names its error with a catalog key: its own wording is hard-coded French, the one
    // the user reads comes from here, in their language.
    if (!response.ok) fail(isErrorKey(result.key) ? result.key : 'authServerUnresponsive')
    return result
  }

  async function renew(saved: string): Promise<AccountCredentials> {
    const result = await backendJson('/auth/refresh', { refreshToken: saved })
    if (typeof result.accessToken !== 'string' || typeof result.refreshToken !== 'string') fail('authServerIncomplete')
    return { accessToken: result.accessToken, refreshToken: result.refreshToken }
  }

  /**
   * Drops a saved account: its credentials, the avatar cached for it, and everything it had set.
   *
   * Each step is best effort and none may skip the next. Signing out keeps all of this on
   * purpose — the account is offered again next launch — so this path is the other one, the one
   * that has to leave nothing behind.
   */
  async function forget(login: string) {
    await parts.accounts.remove(login).catch(() => {})
    await parts.forgetAvatar(login).catch(() => {})
    try { parts.forgetPreferences(login) } catch { /* A row that will not go must not keep the token. */ }
  }

  function drop() {
    token = null
    refreshToken = null
    clientId = null
    userId = null
    follows = false
    data.clear()
    guard.stop()
  }

  function logout(reconnectAnonymously = true) {
    generation++
    drop()
    parts.chat.logout(reconnectAnonymously)
    void parts.switchScope(null).catch(() => {})
    parts.refreshRaidWatch()
  }

  /**
   * A renewed session for the account already connected: only the token changes. The chat keeps
   * its socket — `renewToken` explains why it may — while Helix and EventSub, which authenticate
   * every call, pick the new one up at once. Going back through `connect` would rejoin every room
   * for nothing, four times a day.
   */
  function adopt(credentials: AccountCredentials, validated: ValidatedToken) {
    token = credentials.accessToken
    refreshToken = credentials.refreshToken ?? null
    clientId = validated.clientId
    userId = validated.userId || null
    // A refresh token carries the scopes of the sign-in that opened it: this only ever confirms
    // what was already granted, and must never be left true from the outgoing token.
    follows = validated.follows
    parts.chat.renewToken(credentials.accessToken)
    // The token changed under EventSub: its subscription is remade with the new one, or the raids
    // stay silent until the next room change.
    parts.refreshRaidWatch()
  }

  /**
   * The guard that keeps the session alive. It owns the appointment and the renewal; what it
   * needs it takes through these parts, so its races — an account changed under a network wait,
   * a renewal refused while the token still lives — are testable on their own.
   *
   * It is declared after `drop`, which reaches back into it: nothing below may be called while
   * this line is still running. `createSessionGuard` only builds its timers and returns, so it
   * holds — but a future one that called `parts.logout()` on the way in would find the temporal
   * dead zone rather than the guard.
   */
  const guard = createSessionGuard({
    snapshot: () => ({ token, login: parts.chat.login(), refreshToken, generation }),
    validate,
    renew,
    remember: async (login, credentials) => { await parts.accounts.save(login, credentials.accessToken, credentials.refreshToken) },
    forget,
    adopt,
    logout: () => logout(),
    announce: outcome => parts.announce(outcome),
    timers: parts.timers
  })

  function connect(login: string, credentials: AccountCredentials, validated: ValidatedToken) {
    token = credentials.accessToken
    refreshToken = credentials.refreshToken ?? null
    clientId = validated.clientId
    userId = validated.userId || null
    follows = validated.follows
    data.clear()
    void parts.switchScope(login).catch(error => console.warn('Unable to load the account preferences:', error instanceof Error ? error.message : 'unknown error'))
    parts.chat.connect({ login, token: credentials.accessToken })
    void parts.rememberAvatar(login, { token: credentials.accessToken, clientId: validated.clientId })
      .catch(error => console.warn('Unable to cache the Twitch account avatar:', error instanceof Error ? error.message : 'unknown error'))
    parts.refreshRaidWatch()
    guard.schedule(validated.expiresIn)
  }

  /**
   * A saved account taken back up: its token is checked, renewed if Twitch refuses it, and the
   * account is dropped only when both are refused. Shared by the startup restore and the chooser.
   */
  async function useCredentials(login: string) {
    let credentials = await parts.accounts.credentials(login)
    let validated: ValidatedToken
    try { validated = await validate(credentials.accessToken) }
    catch (error) {
      if (!(error instanceof InvalidTokenError) || !credentials.refreshToken) throw error
      credentials = await renew(credentials.refreshToken)
      validated = await validate(credentials.accessToken)
      await parts.accounts.save(login, credentials.accessToken, credentials.refreshToken)
    }
    if (validated.login !== login) throw new InvalidTokenError('tokenMismatch')
    return { credentials, validated }
  }

  return {
    /** Read afresh at each call: nothing holds a copy of a token across a wait. */
    credentials: () => ({ token, clientId, userId }),
    /** The current generation, and the way to open a new one. A second counter would be a bug. */
    generation: () => generation,
    nextGeneration: () => ++generation,
    authServer,
    data,
    check: () => guard.check(),
    /** The appointment, dropped without touching the credentials: the application is going down. */
    stop: () => guard.stop(),

    /** The chat reported no account: whatever was in flight belongs to nobody now. */
    disconnected() { generation++; drop() },
    /** The window is gone. The credentials go with it; the generation is nobody's to reopen. */
    release() { drop() },
    logout,
    forget,

    /**
     * The account written on disk for auto-login, taken back up at startup.
     *
     * It opens no generation of its own — it is the one the application starts in — but it checks
     * it, and that check is the point. The session gate is on screen while this validation is in
     * flight, so a second account can be signed in under it; without the check, the saved account
     * came back a moment later and took the session from the one the user had just chosen.
     * Forgetting stays unguarded: a token Twitch refused is dead whoever is signed in now.
     */
    async restore() {
      const login = await parts.accounts.preferred()
      if (!login) return
      const opened = generation
      try {
        const { credentials, validated } = await useCredentials(login)
        if (opened !== generation) return
        connect(login, credentials, validated)
      } catch (error) {
        if (error instanceof InvalidTokenError) await forget(login)
      }
    },

    /** A token pasted by hand. Its shape is checked by the caller; Twitch says the rest. */
    async authenticate(candidate: string) {
      const opened = ++generation
      const validated = await validate(candidate)
      if (opened !== generation) fail('authCancelled')
      await parts.accounts.save(validated.login, candidate)
      if (opened !== generation) fail('authCancelled')
      connect(validated.login, { accessToken: candidate }, validated)
      return validated.login
    },

    /** An account picked in the chooser. */
    async useSaved(input: unknown) {
      const login = channelName(input)
      const opened = ++generation
      try {
        const { credentials, validated } = await useCredentials(login)
        if (opened !== generation) fail('authCancelled')
        await parts.accounts.select(login)
        if (opened !== generation) fail('authCancelled')
        connect(login, credentials, validated)
        return login
      } catch (error) {
        if (error instanceof InvalidTokenError) await forget(login)
        throw error
      }
    },

    /**
     * The end of the browser round-trip: the ticket and the verifier drawn with it are exchanged
     * for the tokens. The generation is the one opened when the browser was sent off — a sign-in
     * that finishes after another has started belongs to nobody.
     */
    async claim(ticket: string, verifier: string, opened: number) {
      const result = await backendJson('/auth/claim', { ticket, verifier })
      if (typeof result.accessToken !== 'string') fail('authServerIncomplete')
      const credentials = { accessToken: result.accessToken, refreshToken: typeof result.refreshToken === 'string' ? result.refreshToken : undefined }
      const validated = await validate(credentials.accessToken)
      if (opened !== generation) fail('authCancelled')
      await parts.accounts.save(validated.login, credentials.accessToken, credentials.refreshToken)
      if (opened !== generation) fail('authCancelled')
      connect(validated.login, credentials, validated)
      return validated.login
    }
  }
}
