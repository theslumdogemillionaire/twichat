import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { IrcFramer, messageId, parseIrc, replyReference, stripReplyMention, userNoticeSummary } from './irc-parser'
import { channelName, chatText } from '../shared/validation'
import type { ChatEvent, ChatMessage, Connection, ReplyReference } from '../shared/types'
import { fail } from '../shared/errors'
import { m } from '../shared/i18n'

const badgeNames = (value = '') => value.split(',').filter(Boolean).map(badge => badge.split('/')[0])

export class TwitchIrc extends EventEmitter {
  readonly channels = new Set<string>()
  // Twitch only sends ROOMSTATE on join: the last one is kept so a renderer reload keeps room ids and modes.
  readonly roomStates = new Map<string, Record<string, string>>()
  // Same for USERSTATE: the account badges in each room tell who may post despite followers-only mode.
  readonly userBadges = new Map<string, string[]>()
  status: Connection = 'offline'
  private socket?: WebSocket
  private timer?: ReturnType<typeof setTimeout>
  private handshake?: ReturnType<typeof setTimeout>
  private heartbeat?: ReturnType<typeof setInterval>
  private joinTimers = new Set<ReturnType<typeof setTimeout>>()
  private attempt = 0
  private stopped = false
  private lastReceived = 0
  private sent: number[] = []
  private account?: { login: string; token: string }
  private nick = ''

  get login() { return this.account?.login ?? null }
  private publish(event: ChatEvent) { this.emit('event', event) }
  private state(status: Connection, detail: string) { this.status = status; this.publish({ type: 'status', status, detail }) }

  connect(account = this.account) {
    this.disconnect()
    this.account = account
    this.stopped = false
    this.nick = account?.login ?? `justinfan${Math.floor(Math.random() * 800000) + 100000}`
    this.state(this.attempt ? 'reconnecting' : 'connecting', m.chat.connecting)
    const socket = new WebSocket('wss://irc-ws.chat.twitch.tv:443')
    this.socket = socket
    const framer = new IrcFramer()
    this.handshake = setTimeout(() => socket.close(), 15000)
    socket.addEventListener('open', () => {
      clearTimeout(this.handshake)
      this.lastReceived = Date.now()
      this.write('CAP REQ :twitch.tv/membership twitch.tv/tags twitch.tv/commands')
      this.write(`PASS ${account ? `oauth:${account.token}` : 'SCHMOOPIIE'}`)
      this.write(`NICK ${this.nick}`)
      this.heartbeat = setInterval(() => {
        if (Date.now() - this.lastReceived > 90000) socket.close()
        else this.write('PING :twichat')
      }, 30000)
    })
    socket.addEventListener('message', event => {
      this.lastReceived = Date.now()
      if (typeof event.data !== 'string') { socket.close(); return }
      try { for (const line of framer.push(event.data)) this.handle(line) } catch { socket.close() }
    })
    socket.addEventListener('error', () => { /* The close handler reconnects; never log PASS or raw frames. */ })
    socket.addEventListener('close', () => {
      if (this.socket !== socket || this.stopped) return
      this.clearTimers()
      this.state('reconnecting', m.chat.connectionInterrupted)
      const delay = Math.min(30000, 1000 * 2 ** this.attempt++) + Math.random() * 500
      this.timer = setTimeout(() => this.connect(), delay)
    })
  }

  private write(line: string) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(`${line}\r\n`)
  }

  private handle(line: string) {
    const message = parseIrc(line)
    if (!message) return
    const { command, tags, params, prefix } = message
    const channel = params[0]?.replace(/^#/, '').toLowerCase()
    if (command === 'PING') this.write(`PONG :${params[0] ?? 'tmi.twitch.tv'}`)
    if (command === '001') {
      this.attempt = 0
      this.state('connected', this.account ? m.chat.connectedAs(this.account.login) : m.chat.connectedReadOnly)
      // 1 JOIN / 1.1 s, comfortably below Twitch's regular join rate limit.
      Array.from(this.channels).forEach((room, index) => {
        const timer = setTimeout(() => {
          this.joinTimers.delete(timer)
          if (this.channels.has(room)) this.write(`JOIN #${room}`)
        }, index * 1100)
        this.joinTimers.add(timer)
      })
    }
    if (command === 'RECONNECT') this.socket?.close()
    if (command === 'JOIN' && prefix.split('!')[0].toLowerCase() === this.nick.toLowerCase()) this.publish({ type: 'joined', channel })
    if (command === 'ROOMSTATE') {
      const merged = { ...this.roomStates.get(channel), ...tags }
      this.roomStates.set(channel, merged)
      this.publish({ type: 'roomstate', channel, tags: merged })
    }
    if (command === 'USERSTATE') {
      const badges = badgeNames(tags.badges)
      this.userBadges.set(channel, badges)
      this.publish({ type: 'userstate', channel, badges })
    }
    if (command === 'CLEARMSG') this.publish({ type: 'clear', channel, id: tags['target-msg-id'] })
    if (command === 'CLEARCHAT') this.publish({ type: 'clear', channel, user: params[1]?.toLowerCase() })
    if (command === 'PRIVMSG') {
      const raw = params[1] ?? ''
      const action = raw.startsWith('\x01ACTION ') && raw.endsWith('\x01')
      const reply = replyReference(tags)
      const body = action ? raw.slice(8, -1) : raw
      const { text, emotes } = reply ? stripReplyMention(body, tags.emotes || '', reply.user, reply.login) : { text: body, emotes: tags.emotes || '' }
      this.publish({ type: 'message', message: {
        id: tags.id || randomUUID(), channel, login: prefix.split('!')[0], user: tags['display-name'] || prefix.split('!')[0],
        text, action, color: tags.color || '', badges: badgeNames(tags.badges),
        time: Number(tags['tmi-sent-ts']) || Date.now(), emotes, ...(reply ? { reply } : {})
      } })
    }
    if (command === 'USERNOTICE') {
      // Twitch sends the event line in the tags and, for a resub or an announcement, the viewer's
      // own message as the trailing param. Both are published separately: the `emotes` tag offsets
      // refer to the trailing alone, and the renderer already knows how to style `system`.
      const id = tags.id || randomUUID()
      const time = Number(tags['tmi-sent-ts']) || Date.now()
      const summary = userNoticeSummary(tags)
      const text = params[1] ?? ''
      if (summary) this.publish({ type: 'message', message: {
        id: `${id}:event`, channel, user: 'Twitch', login: 'twitch', text: summary,
        time, color: '', badges: [], action: false, system: true
      } })
      if (text) this.publish({ type: 'message', message: {
        id, channel, login: tags.login || '', user: tags['display-name'] || tags.login || '', text,
        time, color: tags.color || '', badges: badgeNames(tags.badges), action: false, emotes: tags.emotes || ''
      } })
    }
    if (command === 'NOTICE') {
      const text = params.at(-1) ?? m.chat.twitchNotice
      if (/authentication failed|improperly formatted auth|invalid nick/i.test(text)) {
        this.disconnect()
        this.account = undefined
        this.publish({ type: 'account', login: null, detail: m.chat.authRefused })
        this.connect()
      // A NOTICE's text is translated and reworded over the seasons; `msg-id` never moves.
      } else if (this.channels.has(channel)) this.system(channel, text, tags['msg-id'])
    }
  }

  join(value: string) {
    const channel = channelName(value)
    if (this.channels.has(channel)) return
    if (this.channels.size >= 20) fail('ircJoinLimit')
    this.channels.add(channel)
    // Queue interactive joins too, avoiding bursts when multiple rooms are added.
    if (this.status === 'connected') {
      const timer = setTimeout(() => { this.joinTimers.delete(timer); if (this.channels.has(channel)) this.write(`JOIN #${channel}`) }, this.joinTimers.size * 1100)
      this.joinTimers.add(timer)
    }
  }
  part(value: string) { const channel = channelName(value); this.channels.delete(channel); this.roomStates.delete(channel); this.userBadges.delete(channel); this.write(`PART #${channel}`) }
  send(value: string, input: string, replyTo?: ReplyReference) {
    const channel = channelName(value)
    const text = chatText(input)
    // The parent goes out in a raw IRC tag: only a valid Twitch id may enter it.
    const reply = replyTo && messageId(replyTo.id) ? replyTo : undefined
    if (!this.account || this.status !== 'connected') fail('ircNeedAccount')
    if (!this.channels.has(channel)) fail('ircJoinFirst')
    const now = Date.now()
    this.sent = this.sent.filter(time => now - time < 30000)
    if (this.sent.length >= 18 || now - (this.sent.at(-1) ?? 0) < 1100) fail('ircRateLimit')
    this.sent.push(now)
    const action = text.startsWith('/me ')
    this.write(`${reply ? `@reply-parent-msg-id=${reply.id} ` : ''}PRIVMSG #${channel} :${action ? `\x01ACTION ${text.slice(4)}\x01` : text}`)
    const local: ChatMessage = { id: randomUUID(), channel, user: this.account.login, login: this.account.login, text: action ? text.slice(4) : text, time: now, action, color: '', badges: [], own: true, pending: true, ...(reply ? { reply } : {}) }
    // Twitch IRC does not echo the sender's own PRIVMSG. A NOTICE may still reject it.
    this.publish({ type: 'message', message: local })
  }
  system(channel: string, text: string, noticeId = '') {
    const notice = /^[a-z_0-9]{1,60}$/.test(noticeId) ? noticeId : ''
    this.publish({ type: 'message', message: { id: randomUUID(), channel, user: 'Twitch', login: 'twitch', text, time: Date.now(), color: '', badges: [], action: false, system: true, ...(notice ? { notice } : {}) } })
  }
  /**
   * A renewed token for the account already connected. Twitch reads the PASS at connection and
   * never again: the open socket outlives the token it was opened with, so the credential is
   * swapped in place rather than through a reconnection the room would see as a rejoin. The new
   * token serves the next one.
   */
  renewToken(token: string) {
    if (this.account) this.account = { login: this.account.login, token }
  }
  logout(reconnectAnonymously = true) {
    this.account = undefined
    // Badges belong to the account, not the room: they leave with it.
    this.userBadges.clear()
    if (reconnectAnonymously) this.connect()
    else this.disconnect()
  }
  private clearTimers() {
    clearTimeout(this.timer); clearTimeout(this.handshake); clearInterval(this.heartbeat)
    for (const timer of this.joinTimers) clearTimeout(timer)
    this.joinTimers.clear()
  }
  disconnect() {
    this.stopped = true
    this.clearTimers()
    const old = this.socket
    this.socket = undefined
    old?.close()
    this.status = 'offline'
  }
}
