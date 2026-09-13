import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeById } from '../src/renderer/paging'

const row = (id: string, label = `label-${id}`) => ({ id, label })
const byId = (item: { id: string }) => item.id

test('a second page is appended, and what it repeats is not carded twice', () => {
  const first = [row('1'), row('2'), row('3')]
  // Twitch pages a ranking: between the two calls row 3 slipped down and comes back.
  const merged = mergeById(first, [row('3'), row('4'), row('5')], byId)
  assert.deepEqual(merged.map(item => item.id), ['1', '2', '3', '4', '5'])
})

test('the first sighting wins, so a card already scrolled past does not move', () => {
  const merged = mergeById([row('1', 'Just Chatting')], [row('1', 'Renamed'), row('2')], byId)
  assert.deepEqual(merged.map(item => item.label), ['Just Chatting', 'label-2'])
})

test('a page that adds nothing answers with the list it was given', () => {
  const first = [row('1'), row('2')]
  // Same array back, which is how the caller reads "there was nothing more to show".
  assert.equal(mergeById(first, [row('2'), row('1')], byId), first)
  assert.equal(mergeById(first, [], byId), first)
  assert.deepEqual(mergeById([], [], byId), [])
})

test('a page repeating itself is folded as well', () => {
  assert.deepEqual(mergeById([], [row('7'), row('7')], byId).map(item => item.id), ['7'])
})

test('the key is what identifies a row, not its place', () => {
  const streams = [{ channel: 'ponce' }, { channel: 'zerator' }]
  const merged = mergeById(streams, [{ channel: 'zerator' }, { channel: 'mistermv' }], item => item.channel)
  assert.deepEqual(merged.map(item => item.channel), ['ponce', 'zerator', 'mistermv'])
})
