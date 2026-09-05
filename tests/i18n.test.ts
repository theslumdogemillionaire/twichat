import test from 'node:test'
import assert from 'node:assert/strict'
import { en, fr, LOCALES, m, resolveLocale, setLocale } from '../src/shared/i18n'
import { AppError, errorKey, errorText, isSerializedError, serializeError } from '../src/shared/errors'

/** Compares the shape of two catalogs: same keys, same kinds, at every depth. */
function shape(value: unknown, path = ''): string[] {
  if (typeof value === 'function') return [`${path}:fn/${value.length}`]
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, child]) => shape(child, path ? `${path}.${key}` : key))
  return [`${path}:${typeof value}`]
}

test('every catalog carries exactly the keys of the French one, with the same arity', () => {
  // Typing already enforces this at compile time; this test proves it on the values too,
  // including a function's parameter count, which an `as Messages` does not check.
  // Declaration order does not matter; the set of keys and their arity does.
  // Two deliberate exceptions: the subscription tiers, whose vocabulary is Twitch's own,
  // and the emoji aliases, which a language need not supply where the shortcode suffices.
  const varying = (entry: string) => entry.startsWith('chat.subscriptionPlans') || entry.startsWith('emoji.aliases')
  const reference = shape(fr).filter(entry => !varying(entry)).sort()
  const other = shape(en).filter(entry => !varying(entry)).sort()
  assert.deepEqual(other, reference)
})

test('the system language is negotiated on its subtag, an explicit choice comes first', () => {
  assert.equal(resolveLocale('', ['fr-CA', 'en-US']), 'fr')
  assert.equal(resolveLocale('', ['de-DE', 'en-GB']), 'en')
  // A language we do not speak falls back to English, not to the first one listed.
  assert.equal(resolveLocale('', ['ja-JP']), 'en')
  assert.equal(resolveLocale('en', ['fr-FR']), 'en')
  assert.equal(resolveLocale('klingon', ['fr-FR']), 'fr')
  assert.equal(resolveLocale('', []), 'en')
})

test('an error travels by its key and reads in the current language', () => {
  const error = new AppError('channelOffline')
  // The message carries the key: a log must not depend on the user's language.
  assert.match(error.message, /twichat:channelOffline/)
  setLocale('fr')
  assert.equal(errorText(error), fr.errors.channelOffline)
  setLocale('en')
  assert.equal(errorText(error), en.errors.channelOffline)
  const wire = serializeError(error)
  assert.ok(wire && isSerializedError(wire))
  assert.equal(errorText(wire), en.errors.channelOffline)
  // What is not a known error passes through as is, IPC prefix stripped.
  assert.equal(errorText(new Error("Error invoking remote method 'x': Error: boom")), 'boom')
  setLocale('fr')
})

test('the parameters of an error follow the translation', () => {
  setLocale('en')
  assert.equal(errorText(new AppError('emotesUnavailable', [503])), 'Emotes unavailable (503).')
  setLocale('fr')
  assert.equal(errorText(new AppError('emotesUnavailable', [503])), 'Emotes indisponibles (503).')
})

test('the current catalog follows the language switch', () => {
  for (const locale of LOCALES) { setLocale(locale); assert.equal(m.languageName, locale === 'fr' ? 'Français' : 'English') }
  setLocale('fr')
})

test('emoji aliases only target existing shortcodes', async () => {
  const { EMOJIS, searchEmojis } = await import('../src/renderer/emoji')
  const known = new Set(EMOJIS.map(emoji => emoji.name))
  for (const catalog of [fr, en]) {
    for (const shortcode of Object.keys(catalog.emoji.aliases)) {
      assert.ok(known.has(shortcode), `alias for an unknown emoji: ${shortcode}`)
    }
  }
  // The shortcode is an identifier: it finds its emoji whatever the language.
  for (const locale of ['fr', 'en'] as const) {
    setLocale(locale)
    assert.equal(searchEmojis('joy', 1)[0]?.char, '😂')
  }
  // The aliases, though, belong to the language: "mdr" finds nothing in English.
  setLocale('fr')
  assert.equal(searchEmojis('mdr', 1)[0]?.char, '😂')
  setLocale('en')
  assert.equal(searchEmojis('mdr', 1).length, 0)
  assert.equal(searchEmojis('lol', 1)[0]?.char, '😂')
  setLocale('fr')
})

test('an error that crossed the context bridge keeps its key', () => {
  // `contextBridge` copies only `message` and `stack`: only the key written in the message
  // reaches the renderer, with its parameters. It is what decides the player's retry.
  const bridged = new Error('twichat:channelOffline')
  assert.equal(errorKey(bridged), 'channelOffline')
  setLocale('en')
  assert.match(errorText(bridged), /offline/i)
  const withParams = new Error(`Error invoking remote method 'emotes': Error: twichat:emotesUnavailable:[503]`)
  assert.equal(errorKey(withParams), 'emotesUnavailable')
  assert.match(errorText(withParams), /503/)
  setLocale('fr')
  assert.match(errorText(withParams), /503/)
  // An ordinary message stays an ordinary message.
  assert.equal(errorKey(new Error('Twitch a fermé la connexion')), null)
})
