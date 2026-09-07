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
  assert.deepEqual(parseEventSubFrame(frame('revocation', { subscription: { status: 'authorization_revoked' } })), { type: 'revocation', subscription: '' })
  // Twitch names what it took back: one revoked watch must not cost the other its subscription.
  assert.deepEqual(parseEventSubFrame(frame('revocation', { subscription: { status: 'authorization_revoked', type: 'user.whisper.message' } })),
    { type: 'revocation', subscription: 'user.whisper.message' })
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

const whisperFrame = (event: Record<string, unknown>) => parseEventSubFrame(JSON.stringify({
  metadata: { message_id: 'w', message_type: 'notification', message_timestamp: '2026-09-05T12:00:00Z', subscription_type: 'user.whisper.message', subscription_version: '1' },
  payload: { event }
}))
const body = { from_user_id: '9', from_user_login: 'Cat_On_Keyboard', from_user_name: 'Cat_On_Keyboard', to_user_id: '1234', to_user_login: 'TwitchDev', whisper_id: '3c4719ba-fe16-4c75-8f00-78142a375cf1', whisper: { text: 'mrrrp' } }

test('a whisper keeps its sender, its text and the date of the frame that carried it', () => {
  assert.deepEqual(whisperFrame(body), {
    type: 'whisper',
    whisper: { id: '3c4719ba-fe16-4c75-8f00-78142a375cf1', from: 'cat_on_keyboard', fromId: '9', fromDisplayName: 'Cat_On_Keyboard', to: 'twitchdev', text: 'mrrrp', at: Date.parse('2026-09-05T12:00:00Z') }
  })
})

test('a whisper missing what identifies it is discarded rather than half kept', () => {
  // The id is the only thing that tells a whisper apart from the same whisper seen twice:
  // without it, nothing downstream could refuse the duplicate.
  assert.deepEqual(whisperFrame({ ...body, whisper_id: 'espace interdit' }), { type: 'ignored' })
  assert.deepEqual(whisperFrame({ ...body, whisper_id: 'x'.repeat(101) }), { type: 'ignored' })
  // An id that is not the shape of the one documented example is still an id: it names a message
  // Twitch will never send again, and refusing it would lose the whisper rather than protect it.
  assert.equal(whisperFrame({ ...body, whisper_id: 'w-42' }).type, 'whisper')
  assert.deepEqual(whisperFrame({ ...body, from_user_login: 'nom interdit' }), { type: 'ignored' })
  assert.deepEqual(whisperFrame({ ...body, whisper: { text: '   ' } }), { type: 'ignored' })
  assert.deepEqual(whisperFrame({ ...body, whisper: undefined }), { type: 'ignored' })
})

test('an unusable sender id is left empty rather than kept as it came', () => {
  // A reply is addressed to the id: one Twitch did not write in digits would send it nowhere.
  const parsed = whisperFrame({ ...body, from_user_id: 'pas-un-id' })
  assert.equal(parsed.type === 'whisper' && parsed.whisper.fromId, '')
  assert.equal(parsed.type === 'whisper' && parsed.whisper.text, 'mrrrp')
})

test('a whisper falls back to the login when Twitch sends no display name', () => {
  const parsed = whisperFrame({ ...body, from_user_name: undefined })
  assert.equal(parsed.type === 'whisper' && parsed.whisper.fromDisplayName, 'cat_on_keyboard')
})

test('a recipient Twitch left out or wrote unreadably costs nothing but the recipient', () => {
  // The account it belongs to is then the one signed in; the whisper itself must survive.
  for (const to of [undefined, 'nom interdit']) {
    const parsed = whisperFrame({ ...body, to_user_login: to })
    assert.equal(parsed.type === 'whisper' && parsed.whisper.to, '', `to_user_login: ${String(to)}`)
    assert.equal(parsed.type === 'whisper' && parsed.whisper.text, 'mrrrp')
  }
})

test('other notifications and unreadable frames are discarded without breaking the session', () => {
  assert.deepEqual(parseEventSubFrame(frame('notification', { event: { to_broadcaster_user_login: 'dora' } }, 'channel.follow')), { type: 'ignored' })
  assert.deepEqual(parseEventSubFrame('{"metadata":'), { type: 'ignored' })
  assert.deepEqual(parseEventSubFrame('null'), { type: 'ignored' })
  assert.deepEqual(parseEventSubFrame(frame('quelque_chose_de_neuf', {})), { type: 'ignored' })
})
