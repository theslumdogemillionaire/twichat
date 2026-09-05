import test from 'node:test'
import assert from 'node:assert/strict'
import { bufferMode, channelName, chatPreferences, chatText, mediaUrl, notificationPreferences, playbackPreferences, qualityName } from '../src/shared/validation'
import { validatePreferences } from '../src/main/preferences'

test('normalizes a channel name without widening the allowed characters', () => {
  assert.equal(channelName(' #ZeRaTor_2 '), 'zerator_2')
  for (const input of ['', '../secret', 'a b', 'équipe', 'a'.repeat(26)]) assert.throws(() => channelName(input))
})

test('rejects IRC command injections and over-long messages', () => {
  assert.equal(chatText(' bonjour '), 'bonjour')
  assert.equal(chatText('/me arrive'), '/me arrive')
  assert.throws(() => chatText('hello\r\nJOIN #evil'))
  assert.throws(() => chatText('/ban test'))
  assert.throws(() => chatText('é'.repeat(226)))
})

test('restricts video URLs strictly to Twitch CDNs', () => {
  assert.equal(mediaUrl('https://video-weaver-cdg01.ttvnw.net/v1/segment.ts').hostname, 'video-weaver-cdg01.ttvnw.net')
  assert.throws(() => mediaUrl('http://video-weaver-cdg01.ttvnw.net/a'))
  assert.throws(() => mediaUrl('https://ttvnw.net.evil.example/a'))
  assert.throws(() => mediaUrl('https://user@video.ttvnw.net/a'))
})

test('validates preferences and deduplicates channels', () => {
  assert.deepEqual(validatePreferences({ channels: ['One', '#one', 'two'], active: 'two', quality: 'best' }), {
    channels: ['one', 'two'], active: 'two', quality: 'best', theme: 'system', language: '', layout: { playerWidth: 0, sidebarCollapsed: false, hideIdleChannels: true, idleChannelHours: 168 },
    playback: { buffer: 'balanced', autoplay: true, detached: false, volume: 1, muted: false }, notifications: { mentions: true }, chat: { links: true, confirm: true, gifs: true }
  })
  assert.throws(() => qualityName('4k'))
  assert.equal(validatePreferences({ channels: [], active: '', quality: 'best', theme: 'light' }).theme, 'light')
  // An unknown theme must not invalidate otherwise sound preferences.
  assert.equal(validatePreferences({ channels: [], active: '', quality: 'best', theme: 'sepia' }).theme, 'system')
})

test('playback and notifications fall back on the behavior from before the setting', () => {
  // A file written before these settings carries none: video starts and mentions notify, as back then.
  const silent = validatePreferences({ channels: ['zerator'], active: 'zerator', quality: 'best' })
  assert.deepEqual(silent.playback, { buffer: 'balanced', autoplay: true, detached: false, volume: 1, muted: false })
  assert.deepEqual(silent.notifications, { mentions: true })
  assert.deepEqual(silent.chat, { links: true, confirm: true, gifs: true })
  assert.equal(bufferMode('live'), 'live')
  assert.equal(bufferMode('énorme'), 'balanced')
  assert.deepEqual(playbackPreferences({ buffer: 'comfort', autoplay: false, detached: false, volume: .4, muted: true }), { buffer: 'comfort', autoplay: false, detached: false, volume: .4, muted: true })
  assert.deepEqual(notificationPreferences({ mentions: false }), { mentions: false })
  assert.deepEqual(chatPreferences({ links: false }), { links: false, confirm: true, gifs: true })
  assert.deepEqual(chatPreferences({ confirm: false }), { links: true, confirm: false, gifs: true })
  assert.deepEqual(chatPreferences({ gifs: false }), { links: true, confirm: true, gifs: false })
  // Only an explicit false switches it off: a dubious value must not disable a setting behind the account's back.
  assert.deepEqual(playbackPreferences({ buffer: 42, autoplay: 'non', volume: 'fort' }), { buffer: 'balanced', autoplay: true, detached: false, volume: 1, muted: false })
  assert.deepEqual(notificationPreferences('oui'), { mentions: true })
  assert.deepEqual(chatPreferences({ links: 'non' }), { links: true, confirm: true, gifs: true })
})

test('a broken setting does not take the channels down with it', () => {
  // Reading the file catches any exception with empty preferences: nothing incidental may throw.
  const saved = validatePreferences({ channels: ['zerator', 'antoinedaniel'], active: 'zerator', quality: 'best', playback: 'oui', notifications: 7, chat: 'bleu' })
  assert.deepEqual(saved.channels, ['zerator', 'antoinedaniel'])
  assert.deepEqual(saved.playback, { buffer: 'balanced', autoplay: true, detached: false, volume: 1, muted: false })
  assert.deepEqual(saved.notifications, { mentions: true })
  assert.deepEqual(saved.chat, { links: true, confirm: true, gifs: true })
})
