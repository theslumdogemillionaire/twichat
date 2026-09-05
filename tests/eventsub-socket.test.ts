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
  context.eventSub.watch({ token: 'token', clientId: 'client' }, 'zerator', '41719107')
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
  context.eventSub.watch({ token: 'token', clientId: 'client' }, 'zerator', '41719107')
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
  context.eventSub.watch({ token: 'token', clientId: 'client' }, 'zerator', '41719107')
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
  context.eventSub.watch({ token: 'dead-token', clientId: 'client' }, 'zerator', '41719107')
  context.sockets[0].send(welcome('session-1'))
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(unauthorized.length, 1)
  context.eventSub.stop()
})

test('stopping closes the socket and lets nothing else through', async () => {
  const context = harness()
  const raids: unknown[] = []
  context.eventSub.on('raid', notice => raids.push(notice))
  context.eventSub.watch({ token: 'token', clientId: 'client' }, 'zerator', '41719107')
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
