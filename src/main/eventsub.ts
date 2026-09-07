import { EventEmitter } from 'node:events'
import { parseEventSubFrame, type RaidNotice, type WhisperNotice } from './eventsub-parse'
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

/**
 * Everything the session wants watched, declared in full at each call. What is missing is not
 * subscribed: no channel, no raid watch; no user id — an account whose token predates the
 * whisper scope — no whispers.
 */
export interface EventSubTargets {
  /** The channel whose raids to follow, and the id Twitch knows it by. */
  channel: string
  broadcasterId: string
  /** The signed-in user, the one whispers are addressed to. */
  userId: string
}

const ENDPOINT = 'wss://eventsub.wss.twitch.tv/ws'
const SUBSCRIPTIONS = 'https://api.twitch.tv/helix/eventsub/subscriptions'

type SlotName = 'raid' | 'whisper'
/**
 * One subscription, and what became of it. Two of them live here, and they do not have the same
 * lifetime: the raid watch belongs to the room and moves with it, the whispers belong to the
 * account and must outlive every room change.
 */
interface Slot {
  readonly type: 'channel.raid' | 'user.whisper.message'
  /** The condition Twitch will read, or null when there is nothing to watch. */
  wanted: Record<string, string> | null
  /** The condition a subscription is held for. Empty when none is. */
  held: string
  id: string
  /** The condition last asked for, and when: a refusal is not pressed again straight away. */
  attempted: string
  lastAttempt: number
  /** Reported once per condition and per generation, not on every ROOMSTATE. */
  reported: string
  /** The key a renewal was already asked for: a second 401 under it is not the session's doing. */
  unauthorized: string
}

const emptySlot = (type: Slot['type']): Slot =>
  ({ type, wanted: null, held: '', id: '', attempted: '', lastAttempt: 0, reported: '', unauthorized: '' })
/** A condition reduced to one comparable string. The objects are built here, so the order holds. */
const sign = (condition: Record<string, string> | null) => condition ? JSON.stringify(condition) : ''

/**
 * The two things Twitch says nowhere else. An outgoing raid appears in no IRC frame: the leaving
 * channel's chat says nothing about it, only the raided channel's receives a USERNOTICE. And
 * whispers left the chat protocol altogether in February 2023 — EventSub is the only way they
 * still arrive. Both ride the same socket, on subscriptions of unequal lifetime. An anonymous
 * session has no token: nothing is watched.
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
  private sessionId = ''
  private keepalive = 10
  private lastSeen = 0
  private watchdog?: ReturnType<typeof setInterval>
  private retry?: ReturnType<typeof setTimeout>
  private attempt = 0
  // Every socket, and every stop, opens a generation: what comes back from a call sent under
  // the previous one no longer applies, and a refusal is reported again after a reconnect.
  private generation = 0
  private readonly slots: Record<SlotName, Slot> = {
    raid: emptySlot('channel.raid'),
    whisper: emptySlot('user.whisper.message')
  }

  constructor(parts: EventSubParts) {
    super()
    this.fetch = parts.fetch
    this.open = parts.open ?? (url => new WebSocket(url) as unknown as EventSubSocket)
  }

  /** Everything to watch, at once. Without a token, or with nothing left to watch, it all stops. */
  watch(auth: EventSubAuth | null, targets: EventSubTargets) {
    const raid = targets.channel && /^\d{1,30}$/.test(targets.broadcasterId)
      ? { from_broadcaster_user_id: targets.broadcasterId } : null
    const whisper = /^\d{1,30}$/.test(targets.userId) ? { user_id: targets.userId } : null
    if (!auth || (!raid && !whisper)) { this.stop(); return }
    // A different account keeps nothing: its subscriptions were opened under a token that no
    // longer applies, and the whisper one names a user who is no longer the one signed in.
    if (this.auth?.token !== auth.token || this.auth?.clientId !== auth.clientId) this.stop()
    this.auth = auth
    this.channel = targets.channel
    this.slots.raid.wanted = raid
    this.slots.whisper.wanted = whisper
    // Leaving the last room drops the raid watch without touching the whispers.
    for (const slot of this.each()) if (!slot.wanted && slot.held) this.release(slot)
    if (this.socket && this.sessionId) this.subscribeAll()
    else if (!this.socket) this.connect()
  }

  private each() { return Object.values(this.slots) }

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
      // The subscriptions died with the session: nothing to delete, everything to remake.
      for (const slot of this.each()) this.forget(slot)
      clearInterval(this.watchdog)
      if (!this.auth || !this.each().some(slot => slot.wanted)) return
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
      this.subscribeAll(true)
    }
    if (socket !== this.socket) return
    if (frame.type === 'reconnect') this.connect(frame.url)
    if (frame.type === 'revocation') {
      // Twitch names what it took back, when it names anything: a raid revoked on a room change
      // must not cost the whispers their subscription and a needless round trip.
      for (const slot of this.each()) if (!frame.subscription || frame.subscription === slot.type) this.forget(slot)
      this.subscribeAll(true)
    }
    if (frame.type === 'raid' && frame.raid.from === this.channel) this.emit('raid', frame.raid satisfies RaidNotice)
    if (frame.type === 'whisper') this.emit('whisper', frame.whisper satisfies WhisperNotice)
  }

  // Twitch announces its own pace: past one and a half keepalives without a frame, the session is dead.
  private startWatchdog() {
    clearInterval(this.watchdog)
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastSeen > this.keepalive * 1500 + 5000) this.socket?.close()
    }, 5000)
  }

  /**
   * Brings every slot up to what it should be watching. `force` is the fresh session and the
   * revocation, where waiting would leave the subscription for the next room change; without it
   * a condition just refused is left a minute alone, while a new one goes out at once.
   */
  private subscribeAll(force = false) {
    for (const slot of this.each()) {
      const wanted = sign(slot.wanted)
      if (!wanted || slot.held === wanted) continue
      if (!force && slot.attempted === wanted && Date.now() - slot.lastAttempt < 60_000) continue
      void this.subscribe(slot)
    }
  }

  private async subscribe(slot: Slot) {
    const auth = this.auth
    const session = this.sessionId
    const condition = slot.wanted
    const generation = this.generation
    const wanted = sign(condition)
    if (!auth || !session || !condition || slot.held === wanted) return
    const key = `${generation}:${slot.type}:${wanted}`
    slot.held = wanted
    slot.attempted = wanted
    slot.lastAttempt = Date.now()
    const previous = slot.id
    slot.id = ''
    if (previous) void this.remove(previous, auth)
    try {
      const response = await this.fetch(SUBSCRIPTIONS, {
        method: 'POST',
        headers: { Authorization: `Bearer ${auth.token}`, 'Client-Id': auth.clientId, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: slot.type, version: '1',
          condition,
          transport: { method: 'websocket', session_id: session }
        }),
        signal: AbortSignal.timeout(10000)
      })
      if (this.generation !== generation) return
      if (response.status !== 202) {
        if (slot.held === wanted) slot.held = ''
        // A 401 usually says the token died rather than that the subscription was refused: the
        // chat socket survives its own credential, so nothing else here would notice. The account
        // renews, and comes back through `watch` with a token that works. Only when it turns out
        // the session was alive all along does `retrySubscription` bring the attempt back here,
        // and that second refusal — the subscription's own — is the one worth naming.
        if (response.status === 401 && slot.unauthorized !== key) {
          slot.unauthorized = key
          this.emit('unauthorized')
          return
        }
        // Without this line, a refused subscription would only show at the first missed event.
        if (slot.reported !== key) {
          slot.reported = key
          // The raid watch has a room to say it in. The whispers have none yet: they are named
          // apart, and whoever listens decides where a refusal belongs.
          if (slot.type === 'channel.raid') this.emit('notice', this.channel, m.chat.raidWatchUnavailable(response.status))
          else this.emit('unavailable', slot.type, response.status)
        }
        return
      }
      const payload = await response.json() as { data?: { id?: unknown }[] }
      const id = String(payload.data?.[0]?.id ?? '')
      // The room may have changed during the call: the subscription just born is then already stale.
      if (this.generation !== generation || sign(slot.wanted) !== wanted || this.sessionId !== session) { if (id) void this.remove(id, auth); return }
      slot.id = id
      slot.reported = ''
    } catch {
      if (this.generation === generation && slot.held === wanted) slot.held = ''
    }
  }

  /**
   * The session was checked and holds: the 401 came from a subscription itself, and the attempt
   * is made once more instead of waiting for the next room change. The minute `watch` keeps
   * between tries has already been spent, in a round trip to Twitch.
   */
  retrySubscription() { this.subscribeAll(true) }

  /** The subscription is gone as far as Twitch is concerned; only what we knew of it is dropped. */
  private forget(slot: Slot) {
    slot.held = ''
    slot.id = ''
    slot.attempted = ''
    slot.lastAttempt = 0
  }

  /** No longer wanted: Twitch is told, and the slot goes back to watching nothing. */
  private release(slot: Slot) {
    const [auth, id] = [this.auth, slot.id]
    this.forget(slot)
    if (id && auth) void this.remove(id, auth)
  }

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
    const ids = this.each().map(slot => slot.id).filter(Boolean)
    this.auth = null
    this.channel = ''
    this.sessionId = ''
    this.attempt = 0
    for (const slot of this.each()) {
      this.forget(slot)
      slot.wanted = null
      slot.reported = ''
      slot.unauthorized = ''
    }
    clearInterval(this.watchdog)
    clearTimeout(this.retry)
    const [socket, replacement] = [this.socket, this.replacement]
    this.socket = undefined
    this.replacement = undefined
    socket?.close()
    replacement?.close()
    if (auth) for (const id of ids) void this.remove(id, auth)
  }
}
