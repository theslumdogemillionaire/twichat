import test from 'node:test'
import assert from 'node:assert/strict'
import { pinnedAfterScroll } from '../src/renderer/virtual-log'

test('an automatic resize does not unpin the chat', () => {
  assert.equal(pinnedAfterScroll(true, 240, false), true)
})

test('a genuine user scroll away from the bottom unpins the log', () => {
  assert.equal(pinnedAfterScroll(true, 240, true), false)
  assert.equal(pinnedAfterScroll(false, 10, true), true)
})
