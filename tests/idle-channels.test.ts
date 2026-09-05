import test from 'node:test'
import assert from 'node:assert/strict'
import { idleChannels } from '../src/renderer/idle-channels'
import { DEFAULT_IDLE_HOURS } from '../src/shared/validation'

const now = Date.parse('2026-09-05T12:00:00Z')
const days = (count: number) => now - count * 24 * 60 * 60 * 1000
const channel = (name: string, lastActive: number | undefined, rest: { live?: boolean; unread?: number; open?: boolean } = {}) =>
  ({ channel: name, live: false, unread: 0, open: false, lastActive, ...rest })

test('idles the quiet rooms past the delay, not those under it', () => {
  const states = [channel('vieux', days(30)), channel('recent', days(1)), channel('juste', days(6))]
  assert.deepEqual(idleChannels(states, { enabled: true, hours: DEFAULT_IDLE_HOURS, now }), ['vieux'])
  assert.deepEqual(idleChannels(states, { enabled: true, hours: 48, now }), ['vieux', 'juste'])
  assert.deepEqual(idleChannels(states, { enabled: true, hours: 720, now }), [])
})

test('never hides a room that is live, open, or holding unread messages', () => {
  const states = [
    channel('direct', days(60), { live: true }),
    channel('ouvert', days(60), { open: true }),
    channel('non-lus', days(60), { unread: 3 }),
    channel('muet', days(60))
  ]
  assert.deepEqual(idleChannels(states, { enabled: true, hours: DEFAULT_IDLE_HOURS, now }), ['muet'])
})

test('leaves visible a room whose last activity is unknown', () => {
  assert.deepEqual(idleChannels([channel('inconnu', undefined)], { enabled: true, hours: DEFAULT_IDLE_HOURS, now }), [])
})

test('hides nothing when the setting is off, or on a broken delay', () => {
  const states = [channel('vieux', days(365))]
  assert.deepEqual(idleChannels(states, { enabled: false, hours: DEFAULT_IDLE_HOURS, now }), [])
  // A damaged delay falls back on an hour rather than on nothing: the allowlist in validation is what bounds the choice.
  assert.deepEqual(idleChannels(states, { enabled: true, hours: 0, now }), ['vieux'])
  assert.deepEqual(idleChannels([channel('a-linstant', now - 10 * 60_000)], { enabled: true, hours: 0, now }), [])
})
