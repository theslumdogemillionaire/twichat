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

test('a short scroll up near the bottom releases the log instead of springing back', () => {
  assert.equal(pinnedAfterScroll(true, 20, true, true), false)
  assert.equal(pinnedAfterScroll(true, 0, true, true), true)
})

test('scrolling back down within the follow threshold picks the bottom up again', () => {
  assert.equal(pinnedAfterScroll(false, 40, true, false), true)
  assert.equal(pinnedAfterScroll(false, 240, true, false), false)
})

test('a re-pin of our own does not read as a user scroll up', () => {
  assert.equal(pinnedAfterScroll(true, 26, true, false), true)
})
