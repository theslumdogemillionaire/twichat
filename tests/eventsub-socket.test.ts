import test from 'node:test'
import assert from 'node:assert/strict'
import { TwitchEventSub, type EventSubSocket } from '../src/main/eventsub'

/** A socket the test drives: it dispatches the frames Twitch would have sent. */
class FakeSocket implements EventSubSocket {
  readonly listeners = new Map<string, ((event: { data?: unknown }) => void)[]>()
  closed = false
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  close() { this.closed = true; this.dispatch('close') }
  dispatch(type: string, event: { data?: unknown } = {}) { for (const listener of this.listeners.get(type) ?? []) listener(event) }
  send(frame: unknown) { this.dispatch('message', { data: JSON.stringify(frame) }) }
}

const welcome = (sessionId: string) => ({
  metadata: { message_id: 'w', message_type: 'session_welcome', message_timestamp: '2026-09-05T12:00:00Z' },
  payload: { session: { id: sessionId, keepalive_timeout_seconds: 10 } }
})
const raid = (from: string, to: string) => ({
  metadata: { message_id: 'r', message_type: 'notification', message_timestamp: '2026-09-05T12:00:00Z', subscription_type: 'channel.raid', subscription_version: '1' },
  payload: { event: { from_broadcaster_user_login: from, from_broadcaster_user_name: from, to_broadcaster_user_login: to, to_broadcaster_user_name: to, viewers: 42 } }
})

const whisper = (from: string, text: string, id = '3c4719ba-fe16-4c75-8f00-78142a375cf1') => ({
  metadata: { message_id: 'w1', message_type: 'notification', message_timestamp: '2026-09-05T12:00:00Z', subscription_type: 'user.whisper.message', subscription_version: '1' },
  payload: { event: { from_user_id: '9', from_user_login: from, from_user_name: from, to_user_id: '1234', whisper_id: id, whisper: { text } } }
})

/** The client with its socket and its network in the test's hands. */
function harness(status = 202) {
  const sockets: FakeSocket[] = []
  const calls: { method: string; url: string; body: Record<string, any> | null }[] = []
  const eventSub = new TwitchEventSub({
    open: url => { const socket = new FakeSocket(url); sockets.push(socket); return socket },
    fetch: async (url, init) => {
      // The removal is a DELETE and carries no body: parsing one unconditionally would throw,
      // and `remove` swallows its own failures, so the harness would hide the call it is meant
      // to observe.
      calls.push({ method: String(init.method), url, body: init.body ? JSON.parse(String(init.body)) : null })
      return { status, json: async () => ({ data: [{ id: 'subscription-1' }] }) }
    }
  })
  const posts = () => calls.filter(call => call.method === 'POST')
  return { eventSub, sockets, calls, posts }
}

test('the welcome frame is what subscribes, and it carries the session', async () => {
  const context = harness()
  context.eventSub.watch({ token: 'token', clientId: 'client' }, { channel: 'zerator', broadcasterId: '41719107', userId: '' })
  assert.equal(context.sockets.length, 1)
  assert.match(context.sockets[0].url, /^wss:\/\/eventsub\.wss\.twitch\.tv\//)
  // Nothing is subscribed before Twitch names the session: it goes in the request.
  assert.equal(context.posts().length, 0)

  context.sockets[0].send(welcome('session-1'))
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(context.posts().length, 1)
  const body = context.posts()[0].body as Record<string, any>
  assert.equal(body.type, 'channel.raid')
  assert.equal(body.condition.from_broadcaster_user_id, '41719107')
  assert.equal(body.transport.session_id, 'session-1')
  context.eventSub.stop()
})

test('a raid is announced only when it leaves the room being watched', async () => {
  const context = harness()
  const raids: unknown[] = []
  context.eventSub.on('raid', notice => raids.push(notice))
  context.eventSub.watch({ token: 'token', clientId: 'client' }, { channel: 'zerator', broadcasterId: '41719107', userId: '' })
  context.sockets[0].send(welcome('session-1'))
  await new Promise(resolve => setImmediate(resolve))

  // Another channel's raid rides the same socket and is not this room's business.
  context.sockets[0].send(raid('someone-else', 'mistermv'))
  assert.deepEqual(raids, [])

  context.sockets[0].send(raid('zerator', 'mistermv'))
  assert.equal(raids.length, 1)
  assert.equal((raids[0] as { to: string }).to, 'mistermv')
  context.eventSub.stop()
})

test('a reconnect keeps the old socket until the new one is welcomed', async () => {
  // Twitch asks for the move and carries the subscriptions over. Closing first would leave a
  // gap, and a raid falling in it is exactly what this client exists to catch.
  const context = harness()
  context.eventSub.watch({ token: 'token', clientId: 'client' }, { channel: 'zerator', broadcasterId: '41719107', userId: '' })
  const first = context.sockets[0]
  first.send(welcome('session-1'))
  await new Promise(resolve => setImmediate(resolve))

  first.send({
    metadata: { message_id: 'x', message_type: 'session_reconnect', message_timestamp: '2026-09-05T12:00:00Z' },
    payload: { session: { id: 'session-1', reconnect_url: 'wss://eventsub.wss.twitch.tv/ws?reconnect=1' } }
  })
  assert.equal(context.sockets.length, 2)
  assert.equal(first.closed, false, 'the first socket must outlive the request')

  context.sockets[1].send(welcome('session-2'))
  assert.equal(first.closed, true, 'and be closed once the new one is welcomed')
  context.eventSub.stop()
})

test('a subscription Twitch refuses with a 401 asks the session to renew, once', async () => {
  const context = harness(401)
  const unauthorized: number[] = []
  context.eventSub.on('unauthorized', () => unauthorized.push(Date.now()))
  context.eventSub.watch({ token: 'dead-token', clientId: 'client' }, { channel: 'zerator', broadcasterId: '41719107', userId: '' })
  context.sockets[0].send(welcome('session-1'))
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(unauthorized.length, 1)
  context.eventSub.stop()
})

test('stopping closes the socket and lets nothing else through', async () => {
  const context = harness()
  const raids: unknown[] = []
  context.eventSub.on('raid', notice => raids.push(notice))
  context.eventSub.watch({ token: 'token', clientId: 'client' }, { channel: 'zerator', broadcasterId: '41719107', userId: '' })
  const socket = context.sockets[0]
  socket.send(welcome('session-1'))
  await new Promise(resolve => setImmediate(resolve))

  context.eventSub.stop()
  assert.equal(socket.closed, true)
  socket.send(raid('zerator', 'mistermv'))
  assert.equal(raids.length, 0)

  // The subscription is withdrawn rather than left for Twitch to expire on its own.
  await new Promise(resolve => setImmediate(resolve))
  const removal = context.calls.find(call => call.method === 'DELETE')
  assert.ok(removal, `no removal was sent: ${JSON.stringify(context.calls.map(call => call.method))}`)
  assert.match(removal.url, /\?id=subscription-1$/)
})

const account = { token: 'token', clientId: 'client' }
const settled = () => new Promise(resolve => setImmediate(resolve))

test('the two watches ride one socket, and changing room leaves the whispers alone', async () => {
  // The raid watch belongs to the room and moves with it; the whispers belong to the account.
  // Remaking the whisper subscription on every room change would cost a round trip each time,
  // and open a gap where a whisper would simply never arrive.
  const context = harness()
  context.eventSub.watch(account, { channel: 'zerator', broadcasterId: '41719107', userId: '1234' })
  context.sockets[0].send(welcome('session-1'))
  await settled()

  const types = () => context.posts().map(call => String(call.body?.type))
  assert.deepEqual([...types()].sort(), ['channel.raid', 'user.whisper.message'])
  assert.deepEqual(context.posts().find(call => call.body?.type === 'user.whisper.message')?.body?.condition, { user_id: '1234' })

  context.eventSub.watch(account, { channel: 'mistermv', broadcasterId: '28434033', userId: '1234' })
  await settled()

  assert.equal(types().filter(type => type === 'channel.raid').length, 2, 'the raid watch follows the room')
  assert.equal(types().filter(type => type === 'user.whisper.message').length, 1, 'the whisper watch stays as it was')
  context.eventSub.stop()
})

test('leaving the last room drops the raid watch without taking the whispers down', async () => {
  const context = harness()
  context.eventSub.watch(account, { channel: 'zerator', broadcasterId: '41719107', userId: '1234' })
  context.sockets[0].send(welcome('session-1'))
  await settled()

  context.eventSub.watch(account, { channel: '', broadcasterId: '', userId: '1234' })
  await settled()

  assert.equal(context.sockets[0].closed, false, 'the socket still carries the whispers')
  assert.ok(context.calls.some(call => call.method === 'DELETE'), 'the raid subscription is withdrawn rather than left to expire')
  const whispers: unknown[] = []
  context.eventSub.on('whisper', notice => whispers.push(notice))
  context.sockets[0].send(whisper('cat_on_keyboard', 'mrrrp'))
  assert.equal(whispers.length, 1)
  context.eventSub.stop()
})

test('a whisper arrives whatever room is open, and carries the frame date', async () => {
  const context = harness()
  const whispers: { from: string; text: string; at: number }[] = []
  context.eventSub.on('whisper', notice => whispers.push(notice))
  context.eventSub.watch(account, { channel: 'zerator', broadcasterId: '41719107', userId: '1234' })
  context.sockets[0].send(welcome('session-1'))
  await settled()

  context.sockets[0].send(whisper('cat_on_keyboard', 'tu regardes quoi ?'))
  assert.equal(whispers.length, 1)
  assert.equal(whispers[0].from, 'cat_on_keyboard')
  assert.equal(whispers[0].text, 'tu regardes quoi ?')
  // The event says nothing about when it was sent: only the frame does.
  assert.equal(whispers[0].at, Date.parse('2026-09-05T12:00:00Z'))
  context.eventSub.stop()
})

test('an account without the whisper scope watches raids alone', async () => {
  const context = harness()
  context.eventSub.watch(account, { channel: 'zerator', broadcasterId: '41719107', userId: '' })
  context.sockets[0].send(welcome('session-1'))
  await settled()

  assert.deepEqual(context.posts().map(call => String(call.body?.type)), ['channel.raid'])
  context.eventSub.stop()
})
