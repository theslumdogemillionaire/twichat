import test from 'node:test'
import assert from 'node:assert/strict'
import { BUFFER_PROFILES, bufferProfile, STREAM_STALL_TIMEOUT, streamRetryPlan } from '../src/renderer/stream-lifecycle'
import { AppError } from '../src/shared/errors'
import { setLocale } from '../src/shared/i18n'

test('watches a stalled stream and spaces out transient reconnections', () => {
  assert.equal(STREAM_STALL_TIMEOUT, 18_000)
  assert.deepEqual(streamRetryPlan(new AppError('streamInterrupted'), 0), { retry: true, state: 'reconnecting', delay: 3_000 })
  assert.deepEqual(streamRetryPlan(new AppError('streamInterrupted'), 4), { retry: true, state: 'reconnecting', delay: 24_000 })
})

test('polls an offline live stream but not a stream nobody here may watch', () => {
  assert.deepEqual(streamRetryPlan(new AppError('channelOffline'), 0), { retry: true, state: 'offline', delay: 15_000 })
  // Reserved, or not served in this country: retrying changes neither of the two.
  assert.deepEqual(streamRetryPlan(new AppError('streamRestricted'), 0), { retry: false, state: 'error', delay: 0 })
  assert.deepEqual(streamRetryPlan(new AppError('streamGeoblocked'), 0), { retry: false, state: 'error', delay: 0 })
})

test('balanced mode reproduces the original buffer of the player exactly', () => {
  // These values were hardcoded in player.ts: an account that changes nothing must play as before.
  assert.deepEqual(bufferProfile('balanced'), {
    backBufferLength: 10, maxBufferLength: 12, maxMaxBufferLength: 24,
    maxBufferSize: 24 * 1024 * 1024, liveSyncDuration: 3, liveMaxLatencyDuration: 10
  })
})

test('every buffering mode keeps headroom before catching up', () => {
  let previous = 0
  for (const mode of ['live', 'balanced', 'comfort'] as const) {
    const profile = BUFFER_PROFILES[mode]
    // hls.js needs a sync target strictly under the maximum latency, or it is constantly catching up.
    assert.ok(profile.liveSyncDuration < profile.liveMaxLatencyDuration, mode)
    // The byte ceiling must follow the seconds: otherwise it caps the lead before the seconds do on a high-bitrate stream.
    assert.ok(profile.maxBufferSize / (1024 * 1024) >= profile.maxMaxBufferLength / 2, mode)
    assert.ok(profile.maxMaxBufferLength >= profile.maxBufferLength, mode)
    assert.ok(profile.liveSyncDuration > previous, mode)
    previous = profile.liveSyncDuration
  }
})

test('recovery does not depend on the language', () => {
  // The same verdict in both languages: the key decides, not the sentence.
  for (const locale of ['fr', 'en'] as const) {
    setLocale(locale)
    assert.equal(streamRetryPlan(new AppError('channelOffline'), 0).state, 'offline')
    assert.equal(streamRetryPlan(new AppError('streamGeoblocked'), 0).retry, false)
  }
  setLocale('fr')
  // An unknown error stays a reconnection, not an abandonment.
  assert.equal(streamRetryPlan(new Error('boom'), 0).state, 'reconnecting')
})
