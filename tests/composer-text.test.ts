import test from 'node:test'
import assert from 'node:assert/strict'
import { MESSAGE_BYTE_LIMIT, applyCompletion, byteLength, completionQuery, mergeCompletions, rankByTerm, replaceRange, sanitizeOutgoing, tokenizeMessage } from '../src/renderer/composer-text'
import { emojiByName, searchEmojis } from '../src/renderer/emoji'
import { setLocale } from '../src/shared/i18n'
// English is the default language since `en.ts` became the source of truth. The assertions
// below read the French catalog, so the language is pinned rather than inherited.
setLocale('fr')


const emotes = new Set(['OMEGALUL', 'monkaS'])
const emojiNames = new Set(['fire', 'joy'])

test('marks mentions, emotes and links in the input', () => {
  const tokens = tokenizeMessage('salut @ponce OMEGALUL https://twitch.tv', { emotes, emojiNames })
  assert.deepEqual(tokens.map(token => token.kind), ['text', 'mention', 'text', 'emote', 'text', 'url'])
  assert.equal(tokens[1].text, '@ponce')
})

test('flags an unsupported command and accepts /me', () => {
  assert.equal(tokenizeMessage('/me danse', {})[0].kind, 'command')
  assert.equal(tokenizeMessage('/ban toto', {})[0].kind, 'invalid')
})

test('recognizes an emoji shortcode only when it exists', () => {
  assert.equal(tokenizeMessage(':fire:', { emojiNames })[0].kind, 'emoji')
  assert.equal(tokenizeMessage(':inconnu:', { emojiNames })[0].kind, 'text')
})

test('paints the bytes past the Twitch limit as overflow', () => {
  const tokens = tokenizeMessage('a'.repeat(MESSAGE_BYTE_LIMIT + 5), {})
  assert.deepEqual(tokens.map(token => token.kind), ['text', 'overflow'])
  assert.equal(byteLength(tokens[0].text), MESSAGE_BYTE_LIMIT)
  assert.equal(tokens[1].text.length, 5)
})

test('counts emojis in bytes and cuts without breaking the character', () => {
  const text = '🔥'.repeat(120)
  assert.equal(byteLength('🔥'), 4)
  const tokens = tokenizeMessage(text, {})
  assert.equal(byteLength(tokens[0].text), 448)
  assert.equal(tokens[1].kind, 'overflow')
})

test('detects the completion from the prefix under the caret', () => {
  assert.deepEqual(completionQuery('salut @po', 9), { kind: 'mention', term: 'po', start: 6, end: 9 })
  assert.deepEqual(completionQuery('bien :fi', 8), { kind: 'emoji', term: 'fi', start: 5, end: 8 })
  assert.equal(completionQuery('bien mon', 8), null)
  assert.deepEqual(completionQuery('bien mon', 8, true), { kind: 'emote', term: 'mon', start: 5, end: 8 })
  assert.equal(completionQuery('/me danse', 3), null)
})

test('a lone colon opens the shelf, a closed shortcode does not', () => {
  assert.deepEqual(completionQuery('bien :', 6), { kind: 'emoji', term: '', start: 5, end: 6 })
  assert.equal(completionQuery('bien :joy:', 10), null)
  assert.equal(completionQuery('bien ::', 7), null)
})

test('merges two ranked lists without letting either crowd the other out', () => {
  const emotes = ['Kappa', 'KappaPride', 'KEKW', 'Kreygasm', 'KappaRoss', 'KappaHD']
  const emojis = [':kiss:', ':key:', ':keyboard:', ':kimono:', ':koala:', ':knife:']
  assert.deepEqual(mergeCompletions(emotes, emojis, 8), ['Kappa', 'KappaPride', 'KEKW', 'Kreygasm', ':kiss:', ':key:', ':keyboard:', ':kimono:'])
  // One side empty: the other takes the whole shelf rather than leaving it half-full.
  assert.deepEqual(mergeCompletions(emotes, [], 4), ['Kappa', 'KappaPride', 'KEKW', 'Kreygasm'])
  assert.deepEqual(mergeCompletions([], emojis, 4), [':kiss:', ':key:', ':keyboard:', ':kimono:'])
  // A name typed in full wins, wherever it came from.
  const exact = mergeCompletions(emotes, emojis, 8, entry => entry.replace(/^:|:$/gu, '').toLowerCase() === 'key')
  assert.equal(exact[0], ':key:')
})

test('replaces the whole word even when the caret sits in the middle', () => {
  const query = completionQuery('@pon salut', 4)
  assert.ok(query)
  assert.deepEqual(applyCompletion('@pon salut', query, '@ponce'), { text: '@ponce salut', caret: 6 })
})

test('does not add a second space after an insertion', () => {
  assert.deepEqual(replaceRange('a b', 1, 1, 'X'), { text: 'aX b', caret: 2 })
  assert.deepEqual(replaceRange('ab', 2, 2, 'X'), { text: 'abX ', caret: 4 })
})

test('normalizes the line breaks Twitch refuses', () => {
  assert.equal(sanitizeOutgoing('  salut\n\ntoi  '), 'salut toi')
})

test('ranks prefix matches ahead of inner matches', () => {
  const codes = ['superMonka', 'monkaS', 'monkaW']
  assert.deepEqual(rankByTerm(codes, 'monka', code => [code]), ['monkaS', 'monkaW', 'superMonka'])
})

test('emoji search favors the exact name', () => {
  assert.equal(searchEmojis('fire')[0].char, '🔥')
  assert.equal(emojiByName('joy')?.char, '😂')
  assert.equal(searchEmojis('rire').some(emoji => emoji.char === '😂'), true)
})
