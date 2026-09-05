import { EventEmitter } from 'node:events'
import { parseEventSubFrame, type RaidNotice } from './eventsub-parse'
import { m } from '../shared/i18n'

export interface EventSubAuth { token: string; clientId: string }

/**
 * What this client needs of a socket, and of the network. The real `WebSocket` and `net.fetch`
 * satisfy it; a test supplies its own and drives the frames itself, which is the only way the
 * reconnect and the subscription can be exercised without Twitch on the other end.
 */
export interface EventSubSocket {
  addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: { data?: unknown }) => void): void
  close(): void
}
export interface EventSubParts {
  /** Required: importing Electron's `net` here would make this file unloadable outside Electron. */
  fetch(url: string, init: RequestInit): Promise<{ status: number; json(): Promise<unknown> }>
  open?(url: string): EventSubSocket
}

const ENDPOINT = 'wss://eventsub.wss.twitch.tv/ws'
const SUBSCRIPTIONS = 'https://api.twitch.tv/helix/eventsub/subscriptions'

/**
 * An outgoing raid appears nowhere in IRC: the leaving channel's chat says nothing about it, only
 * the raided channel's receives a USERNOTICE. EventSub does carry it, over WebSocket and with no
 * extra scope — a `channel.raid` subscription on the watched channel, redone on every room
 * change. An anonymous session has no token: raid following then stays off.
 */
export class TwitchEventSub extends EventEmitter {
  private readonly open: (url: string) => EventSubSocket
  private readonly fetch: EventSubParts['fetch']
  private socket?: EventSubSocket
  // A resume keeps the old socket alive until the new one's `session_welcome`: Twitch
  // carries the subscriptions over, and no raid may fall in the gap.
  private replacement?: EventSubSocket
  private auth: EventSubAuth | null = null
  private channel = ''
  private broadcasterId = ''
  private sessionId = ''
  private subscriptionId = ''
  private subscribedTo = ''
  private keepalive = 10
  private lastSeen = 0
  private watchdog?: ReturnType<typeof setInterval>
  private retry?: ReturnType<typeof setTimeout>
  private attempt = 0
  private lastAttempt = 0
  // Every socket, and every stop, opens a generation: what comes back from a call sent under
  // the previous one no longer applies, and a refusal is reported again after a reconnect.
  private generation = 0
  // A refusal from Twitch is reported once per channel and per generation, not on every ROOMSTATE.
  private reported = ''
  // The key a renewal was already asked for: a second 401 under it is not the session's doing.
  private unauthorized = ''

  constructor(parts: EventSubParts) {
    super()
    this.fetch = parts.fetch
    this.open = parts.open ?? (url => new WebSocket(url) as unknown as EventSubSocket)
  }

  /** The channel whose raids to follow. Without a token or a channel id, following stops. */
  watch(auth: EventSubAuth | null, channel: string, broadcasterId: string) {
    if (!auth || !channel || !/^\d{1,30}$/.test(broadcasterId)) { this.stop(); return }
    const sameAccount = this.auth?.token === auth.token && this.auth?.clientId === auth.clientId
    if (sameAccount && this.broadcasterId === broadcasterId && this.socket) {
      // An EventSub session lasts hours: a subscription refused on the first try would otherwise
      // be retried only on the next reconnect. A minute apart is enough not to press.
      if (this.sessionId && this.subscribedTo !== broadcasterId && Date.now() - this.lastAttempt > 60_000) void this.subscribe()
      return
    }
    if (!sameAccount) this.stop()
    this.auth = auth
    this.channel = channel
    this.broadcasterId = broadcasterId
    if (this.socket && this.sessionId) void this.subscribe()
    else if (!this.socket) this.connect()
  }

  private connect(url = ENDPOINT) {
    this.generation++
    const socket = this.open(url)
    const resuming = url !== ENDPOINT
    if (resuming) this.replacement = socket
    else this.socket = socket
    socket.addEventListener('open', () => { this.lastSeen = Date.now() })
    socket.addEventListener('message', event => {
      if (typeof event.data !== 'string') return
      this.lastSeen = Date.now()
      this.handle(event.data, socket)
    })
    socket.addEventListener('error', () => { /* The close reopens: nothing to log from a Twitch socket. */ })
    socket.addEventListener('close', () => {
      if (socket === this.replacement) { this.replacement = undefined; return }
      if (socket !== this.socket) return
      this.socket = undefined
      this.sessionId = ''
      this.subscribedTo = ''
      this.subscriptionId = ''
      clearInterval(this.watchdog)
      if (!this.auth || !this.broadcasterId) return
      const delay = Math.min(30000, 1000 * 2 ** this.attempt++) + Math.random() * 500
      this.retry = setTimeout(() => this.connect(), delay)
    })
  }

  private handle(raw: string, socket: EventSubSocket) {
    const frame = parseEventSubFrame(raw)
    if (frame.type === 'welcome') {
      this.attempt = 0
      this.keepalive = frame.keepalive
      // The new socket carries the session: the old one can go, its subscriptions came along.
      if (socket === this.replacement) {
        this.replacement = undefined
        const old = this.socket
        this.socket = socket
        this.sessionId = frame.sessionId
        old?.close()
        return
      }
      this.sessionId = frame.sessionId
      this.startWatchdog()
      void this.subscribe()
    }
    if (socket !== this.socket) return
    if (frame.type === 'reconnect') this.connect(frame.url)
    if (frame.type === 'revocation') { this.subscribedTo = ''; this.subscriptionId = ''; void this.subscribe() }
    if (frame.type === 'raid' && frame.raid.from === this.channel) this.emit('raid', frame.raid satisfies RaidNotice)
  }

  // Twitch announces its own pace: past one and a half keepalives without a frame, the session is dead.
  private startWatchdog() {
    clearInterval(this.watchdog)
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastSeen > this.keepalive * 1500 + 5000) this.socket?.close()
    }, 5000)
  }

  private async subscribe() {
    const auth = this.auth
    const session = this.sessionId
    const broadcasterId = this.broadcasterId
    const generation = this.generation
    if (!auth || !session || !broadcasterId || this.subscribedTo === broadcasterId) return
    const key = `${generation}:${broadcasterId}`
    this.subscribedTo = broadcasterId
    this.lastAttempt = Date.now()
    const previous = this.subscriptionId
    this.subscriptionId = ''
    if (previous) void this.remove(previous, auth)
    try {
      const response = await this.fetch(SUBSCRIPTIONS, {
        method: 'POST',
        headers: { Authorization: `Bearer ${auth.token}`, 'Client-Id': auth.clientId, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'channel.raid', version: '1',
          condition: { from_broadcaster_user_id: broadcasterId },
          transport: { method: 'websocket', session_id: session }
        }),
        signal: AbortSignal.timeout(10000)
      })
      if (this.generation !== generation) return
      if (response.status !== 202) {
        if (this.subscribedTo === broadcasterId) this.subscribedTo = ''
        // A 401 usually says the token died rather than that the subscription was refused: the
        // chat socket survives its own credential, so nothing else here would notice. The account
        // renews, and comes back through `watch` with a token that works. Only when it turns out
        // the session was alive all along does `retrySubscription` bring the attempt back here,
        // and that second refusal — the subscription's own — is the one worth naming.
        if (response.status === 401 && this.unauthorized !== key) {
          this.unauthorized = key
          this.emit('unauthorized')
          return
        }
        // Without this line, a refused subscription would only show at the first missed raid.
        if (this.reported !== key) {
          this.reported = key
          this.emit('notice', this.channel, m.chat.raidWatchUnavailable(response.status))
        }
        return
      }
      const payload = await response.json() as { data?: { id?: unknown }[] }
      const id = String(payload.data?.[0]?.id ?? '')
      // The room may have changed during the call: the subscription just born is then already stale.
      if (this.generation !== generation || this.broadcasterId !== broadcasterId || this.sessionId !== session) { if (id) void this.remove(id, auth); return }
      this.subscriptionId = id
      this.reported = ''
    } catch {
      if (this.generation === generation && this.subscribedTo === broadcasterId) this.subscribedTo = ''
    }
  }

  /**
   * The session was checked and holds: the 401 came from the subscription itself, and the attempt
   * is made once more instead of waiting for the next room change. The minute `watch` keeps
   * between tries has already been spent, in a round trip to Twitch.
   */
  retrySubscription() { void this.subscribe() }

  private async remove(id: string, auth: EventSubAuth) {
    try {
      await this.fetch(`${SUBSCRIPTIONS}?id=${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${auth.token}`, 'Client-Id': auth.clientId },
        signal: AbortSignal.timeout(10000)
      })
    } catch { /* Twitch revokes a closed session's subscriptions on its own. */ }
  }

  stop() {
    this.generation++
    const auth = this.auth
    const id = this.subscriptionId
    this.auth = null
    this.channel = ''
    this.broadcasterId = ''
    this.sessionId = ''
    this.subscribedTo = ''
    this.subscriptionId = ''
    this.reported = ''
    this.unauthorized = ''
    this.attempt = 0
    this.lastAttempt = 0
    clearInterval(this.watchdog)
    clearTimeout(this.retry)
    const [socket, replacement] = [this.socket, this.replacement]
    this.socket = undefined
    this.replacement = undefined
    socket?.close()
    replacement?.close()
    if (id && auth) void this.remove(id, auth)
  }
}
