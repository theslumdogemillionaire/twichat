import test from 'node:test'
import assert from 'node:assert/strict'
import { liveUptime } from '../src/renderer/live-stats'
import { setLocale } from '../src/shared/i18n'
// English is the default language since `en.ts` became the source of truth. The assertions
// below read the French catalog, so the language is pinned rather than inherited.
setLocale('fr')


const start = Date.parse('2026-09-05T10:00:00Z')

test('counts the live stream uptime in minutes then in hours', () => {
  assert.equal(liveUptime('2026-09-05T10:00:00Z', start + 45 * 60_000), '45 min')
  assert.equal(liveUptime('2026-09-05T10:00:00Z', start + 124 * 60_000), '2 h 04')
  assert.equal(liveUptime('2026-09-05T10:00:00Z', start), '0 min')
})

test('does not time a live stream with no start time nor a local clock running ahead', () => {
  assert.equal(liveUptime(undefined, start), '')
  assert.equal(liveUptime('', start), '')
  assert.equal(liveUptime('pas une date', start), '')
  assert.equal(liveUptime('2026-09-05T10:00:00Z', start - 60_000), '0 min')
})
