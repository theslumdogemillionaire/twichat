import test from 'node:test'
import assert from 'node:assert/strict'
import { isMention, mentionSegments } from '../src/renderer/mentions'
import type { ChatMessage, ReplyReference } from '../src/shared/types'

const message = (text: string, login = 'alice', extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id: '1', channel: 'room', login, user: login, text, color: '', badges: [], time: 0, action: false, ...extra })
const reply = (login: string): ReplyReference =>
  ({ id: '0', login, user: login, text: 'salut', threadId: '0', threadLogin: login, threadUser: login })

test('spots the nickname with or without an at sign, regardless of case', () => {
  assert.equal(isMention(message('salut @Bob ça va ?'), 'bob'), true)
  assert.equal(isMention(message('bob tu es là ?'), 'bob'), true)
  assert.equal(isMention(message('SALUT BOB'), 'bob'), true)
  assert.equal(isMention(message('coucou @bob, bien joué'), 'bob'), true)
})

test('ignores a nickname caught inside a longer word', () => {
  assert.equal(isMention(message('bobby a raison'), 'bob'), false)
  assert.equal(isMention(message('un bob_le_bricoleur passe'), 'bob'), false)
  assert.equal(isMention(message('rebob'), 'bob'), false)
})

test('never counts your own message as a mention, even on the Twitch echo with no `own`', () => {
  assert.equal(isMention(message('je parle de bob', 'bob'), 'bob'), false)
  assert.equal(isMention(message('re', 'bob', { reply: reply('bob') }), 'bob'), false)
})

test('counts a reply to your own message as a mention', () => {
  assert.equal(isMention(message('exactement', 'alice', { reply: reply('bob') }), 'bob'), true)
  assert.equal(isMention(message('exactement', 'alice', { reply: reply('carol') }), 'bob'), false)
})

test('leaves system lines and anonymous sessions alone', () => {
  assert.equal(isMention(message('bob vient de s’abonner.', 'alice', { system: true }), 'bob'), false)
  assert.equal(isMention(message('salut bob'), null), false)
  assert.equal(isMention(message('salut bob'), ''), false)
})

test('also compares the display name when it differs from the login', () => {
  assert.equal(isMention(message('merci ボブ !'), 'bob', 'ボブ'), true)
  assert.equal(isMention(message('merci @Bob !'), 'bob', 'ボブ'), true)
})

test('splits the text to wrap only the nickname', () => {
  assert.deepEqual(mentionSegments('salut @bob ça va', 'bob'), [
    { text: 'salut ', mention: false },
    { text: '@bob', mention: true },
    { text: ' ça va', mention: false }
  ])
  assert.deepEqual(mentionSegments('bob', 'bob'), [{ text: 'bob', mention: true }])
  assert.deepEqual(mentionSegments('rien à signaler', 'bob'), [{ text: 'rien à signaler', mention: false }])
  assert.deepEqual(mentionSegments('salut', null), [{ text: 'salut', mention: false }])
})

test('splits every occurrence without losing text', () => {
  const text = '@bob puis bob encore, bob.'
  const segments = mentionSegments(text, 'bob')
  assert.equal(segments.map(segment => segment.text).join(''), text)
  assert.equal(segments.filter(segment => segment.mention).length, 3)
})

test('treats a nickname with special characters as text, not as a pattern', () => {
  assert.equal(isMention(message('salut a.c'), 'a.c'), true)
  assert.equal(isMention(message('salut abc'), 'a.c'), false)
})
