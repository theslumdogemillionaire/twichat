import test from 'node:test'
import assert from 'node:assert/strict'
import { parseEventSubFrame } from '../src/main/eventsub-parse'

const frame = (type: string, payload: unknown, subscriptionType?: string) =>
  JSON.stringify({ metadata: { message_id: 'm1', message_type: type, message_timestamp: '2026-09-05T12:00:00Z', ...(subscriptionType ? { subscription_type: subscriptionType, subscription_version: '1' } : {}) }, payload })

const raid = (event: Record<string, unknown>) => parseEventSubFrame(frame('notification', { event }, 'channel.raid'))

test('the welcome delivers the session and the announced keepalive interval', () => {
  const parsed = parseEventSubFrame(frame('session_welcome', { session: { id: 'AQoQ…', status: 'connected', keepalive_timeout_seconds: 30 } }))
  assert.deepEqual(parsed, { type: 'welcome', sessionId: 'AQoQ…', keepalive: 30 })
})

test('a welcome without keepalive falls back to the Twitch default', () => {
  const parsed = parseEventSubFrame(frame('session_welcome', { session: { id: 'abc' } }))
  assert.deepEqual(parsed, { type: 'welcome', sessionId: 'abc', keepalive: 10 })
})

test('the reconnect is followed only to an encrypted address', () => {
  assert.deepEqual(parseEventSubFrame(frame('session_reconnect', { session: { id: 'abc', reconnect_url: 'wss://eventsub.wss.twitch.tv/ws?challenge=1' } })),
    { type: 'reconnect', url: 'wss://eventsub.wss.twitch.tv/ws?challenge=1' })
  assert.deepEqual(parseEventSubFrame(frame('session_reconnect', { session: { id: 'abc', reconnect_url: 'http://ailleurs.example/ws' } })), { type: 'ignored' })
})

test('keepalive and revocation are recognized', () => {
  assert.deepEqual(parseEventSubFrame(frame('session_keepalive', {})), { type: 'keepalive' })
  assert.deepEqual(parseEventSubFrame(frame('revocation', { subscription: { status: 'authorization_revoked' } })), { type: 'revocation' })
})

test('an outgoing raid gives the destination channel and the viewer count', () => {
  assert.deepEqual(raid({
    from_broadcaster_user_id: '1', from_broadcaster_user_login: 'Dora', from_broadcaster_user_name: 'Dora',
    to_broadcaster_user_id: '2', to_broadcaster_user_login: 'chez_bob', to_broadcaster_user_name: 'Chez_Bob', viewers: 42
  }), { type: 'raid', raid: { from: 'dora', to: 'chez_bob', toDisplayName: 'Chez_Bob', viewers: 42 } })
})

test('the display name falls back to the login, the viewer count to zero', () => {
  const parsed = raid({ from_broadcaster_user_login: 'dora', to_broadcaster_user_login: 'chez_bob', viewers: 'beaucoup' })
  assert.deepEqual(parsed, { type: 'raid', raid: { from: 'dora', to: 'chez_bob', toDisplayName: 'chez_bob', viewers: 0 } })
})

test('an unusable raid moves nobody', () => {
  // A channel raiding itself: Twitch allows it in tests, and following it would lead nowhere.
  assert.deepEqual(raid({ from_broadcaster_user_login: 'dora', to_broadcaster_user_login: 'dora', viewers: 3 }), { type: 'ignored' })
  assert.deepEqual(raid({ from_broadcaster_user_login: 'dora', to_broadcaster_user_login: 'chaîne interdite', viewers: 3 }), { type: 'ignored' })
  assert.deepEqual(raid({ from_broadcaster_user_login: 'dora' }), { type: 'ignored' })
})

test('other notifications and unreadable frames are discarded without breaking the session', () => {
  assert.deepEqual(parseEventSubFrame(frame('notification', { event: { to_broadcaster_user_login: 'dora' } }, 'channel.follow')), { type: 'ignored' })
  assert.deepEqual(parseEventSubFrame('{"metadata":'), { type: 'ignored' })
  assert.deepEqual(parseEventSubFrame('null'), { type: 'ignored' })
  assert.deepEqual(parseEventSubFrame(frame('quelque_chose_de_neuf', {})), { type: 'ignored' })
})
