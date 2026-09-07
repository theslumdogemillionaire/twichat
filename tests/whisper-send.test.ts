import test from 'node:test'
import assert from 'node:assert/strict'
import { errorKey } from '../src/shared/errors'
import { whisperFailure, whisperText, WHISPER_LIMIT } from '../src/shared/validation'

test('a refusal is named by what the user can do about it', () => {
  // The two Twitch pages disagree on the code for a recipient who refuses whispers — the API
  // reference says 403, the whispers page says 400 — so both say the same thing here.
  assert.equal(whisperFailure(400), 'whisperRefused')
  assert.equal(whisperFailure(403), 'whisperRefused')
  // The scope was checked before the call: what is left under a 401 is the phone, or the session.
  assert.equal(whisperFailure(401), 'whisperNeedsPhone')
  assert.equal(whisperFailure(429), 'whisperTooMany')
  assert.equal(whisperFailure(500), 'whisperUnavailable')
  assert.equal(whisperFailure(0), 'whisperUnavailable')
})

/** The key an attempt failed on, or null when it went through. */
const keyOf = (run: () => unknown) => { try { run(); return null } catch (error) { return errorKey(error) } }

test('a message is trimmed, and refused before Twitch has to refuse it', () => {
  assert.equal(whisperText('  salut  '), 'salut')
  for (const empty of ['', '   ', 42, null, undefined]) {
    assert.equal(keyOf(() => whisperText(empty)), 'whisperEmpty', `accepted ${JSON.stringify(empty)}`)
  }
})

test('the length is counted in characters, not in code units', () => {
  // An emoji is one character and two code units: measuring the string's `length` would refuse
  // a message half the allowed size.
  const emoji = '🎹'.repeat(WHISPER_LIMIT)
  assert.equal(whisperText(emoji), emoji)
  assert.equal(keyOf(() => whisperText('a'.repeat(WHISPER_LIMIT + 1))), 'whisperTooLong')
  assert.equal(keyOf(() => whisperText('🎹'.repeat(WHISPER_LIMIT + 1))), 'whisperTooLong')
})
