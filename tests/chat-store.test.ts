import test from 'node:test'
import assert from 'node:assert/strict'
import { ChatStore, HISTORY_LIMIT } from '../src/renderer/chat-store'
import type { ChatMessage } from '../src/shared/types'

const message = (id: string, login = 'alice', own = false): ChatMessage => ({ id, channel: 'room', login, user: login, text: id, color: '', badges: [], time: Number(id) || Date.now(), action: false, own })

test('caps the history of each channel', () => {
  const store = new ChatStore()
  for (let i = 0; i < HISTORY_LIMIT + 40; i++) store.add(message(String(i)))
  assert.equal(store.get('room').length, HISTORY_LIMIT)
  assert.equal(store.get('room')[0].id, '40')
})

test('reconciles an optimistic message with its IRC echo', () => {
  const store = new ChatStore()
  const pending = { ...message('local', 'bob', true), text: 'salut', time: 1000 }
  const server = { ...message('server', 'bob'), text: 'salut', time: 1500 }
  store.add(pending); store.add(server)
  assert.equal(store.get('room').length, 1)
  assert.equal(store.get('room')[0].id, 'server')
  assert.equal(store.get('room')[0].own, true)
})

test('applies moderation by message, by user or by channel', () => {
  const store = new ChatStore()
  store.add(message('1')); store.add(message('2', 'bob'))
  store.clear('room', undefined, '1'); assert.deepEqual(store.get('room').map(item => item.id), ['2'])
  store.clear('room', 'bob'); assert.equal(store.get('room').length, 0)
})
