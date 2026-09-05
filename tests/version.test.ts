import test from 'node:test'
import assert from 'node:assert/strict'
import { isNewer } from '../src/shared/version'

test('compares the three numbers before anything else', () => {
  assert.equal(isNewer('0.2.0', '0.1.0'), true)
  assert.equal(isNewer('0.1.1', '0.1.0'), true)
  assert.equal(isNewer('1.0.0', '0.9.9'), true)
  assert.equal(isNewer('0.1.0', '0.1.0'), false)
  assert.equal(isNewer('0.1.0', '0.2.0'), false)
  // Ten is not read as one followed by a zero.
  assert.equal(isNewer('0.10.0', '0.9.0'), true)
})

test('the leading v of a tag is not part of the version', () => {
  assert.equal(isNewer('v0.2.0', '0.1.0'), true)
  assert.equal(isNewer('v0.1.0', '0.1.0'), false)
})

test('a prerelease loses to the same numbers released', () => {
  assert.equal(isNewer('0.2.0', '0.2.0-beta.1'), true)
  assert.equal(isNewer('0.2.0-beta.1', '0.2.0'), false)
  assert.equal(isNewer('0.2.0-beta.2', '0.2.0-beta.1'), true)
  assert.equal(isNewer('0.2.0-beta.10', '0.2.0-beta.9'), true)
  assert.equal(isNewer('0.2.0-beta', '0.2.0-alpha'), true)
  // A prerelease of a higher version still wins over the release below it.
  assert.equal(isNewer('0.3.0-alpha.1', '0.2.0'), true)
})

test('an unreadable version never pushes an update, nor hides one', () => {
  assert.equal(isNewer('nightly', '0.1.0'), false)
  assert.equal(isNewer('', '0.1.0'), false)
  assert.equal(isNewer('0.2', '0.1.0'), false)
  assert.equal(isNewer('0.2.0', 'unknown'), false)
})
