import test from 'node:test'
import assert from 'node:assert/strict'
import { TwitchIrc } from '../src/main/irc'
import { communityNotice } from '../src/main/irc-parser'
import { ChatStore } from '../src/renderer/chat-store'
import { groupNoticeMessages } from '../src/renderer/notice-groups'
import { cheerEmphasis } from '../src/renderer/community-message'
import { setLocale } from '../src/shared/i18n'
import type { ChatEvent, ChatMessage } from '../src/shared/types'

function feed(kind: string, extra = '', body = '') {
  const messages: ChatMessage[] = []
  const irc = new TwitchIrc()
  irc.on('event', (event: ChatEvent) => { if (event.type === 'message') messages.push(event.message) })
  ;(irc as unknown as { handle(line: string): void }).handle(`@id=notice;msg-id=${kind};login=alice;display-name=Alice;emotes=25:0-4;msg-param-sub-plan=Prime${extra} :tmi.twitch.tv USERNOTICE #room${body ? ` :${body}` : ''}`)
  return messages
}

test('subscription and announcement bodies join the exact event without losing ids or emote offsets', () => {
  for (const kind of ['sub', 'resub', 'announcement']) {
    const [event, body] = feed(kind, ';msg-param-cumulative-months=12', 'Kappa un an déjà !')
    const store = new ChatStore(); store.add(event)
    assert.equal(store.display('room')[0].noticeBody, undefined)
    store.add(body)
    const [shown] = store.display('room')
    assert.equal(store.display('room').length, 1)
    assert.equal(shown.noticeBody, body)
    assert.equal(shown.noticeBody!.emotes, '25:0-4')
    assert.equal(shown.noticeBody!.id, 'notice')
    assert.equal(store.get('room').length, 2)
    assert.equal(shown, store.display('room')[0])
    assert.equal(event.noticeBody, undefined)
    store.clear('room', undefined, body.id)
    assert.equal(store.display('room')[0].noticeBody, undefined, 'deleted text disappears from the card')
    store.add(body); store.clear('room', undefined, event.id)
    assert.deepEqual(store.display('room'), [body], 'body survives eviction of its summary')
  }
})

test('grouping rejects other authors, rooms, system lines and merely adjacent messages', () => {
  const [event, body] = feed('resub', '', 'bonjour')
  for (const other of [{ ...body, id: 'other' }, { ...body, login: 'bob' }, { ...body, channel: 'other' }, { ...body, system: true }]) {
    assert.equal(groupNoticeMessages([event, other]).length, 2)
  }
  const bot = { ...body, id: 'bot', login: 'bot' }
  assert.deepEqual(groupNoticeMessages([event, bot, body]).map(message => message.id), [event.id, bot.id])
  const store = new ChatStore(); store.add(event); store.add(body); store.clear('room', 'alice')
  assert.equal(store.display('room')[0].noticeBody, undefined, 'user purge removes nested body too')
})

test('missing or malformed subscription details remain unknown, unsupported milestones remain ordinary', () => {
  const sub = feed('sub')[0].communityNotice!
  assert.ok(sub.kind === 'subscription'); assert.equal(sub.months, 1); assert.equal(sub.plan, 'Prime')
  for (const value of ['', '0', '-1', 'NaN', '1.5', '9007199254740992']) {
    const notice = communityNotice({ 'msg-id': 'resub', 'msg-param-cumulative-months': value, 'msg-param-sub-plan': '<script>' })!
    assert.ok(notice.kind === 'subscription'); assert.equal(notice.months, null); assert.equal(notice.plan, '')
    assert.equal(communityNotice({ 'msg-id': 'viewermilestone', 'msg-param-category': 'watch-streak', 'msg-param-value': value }), undefined)
  }
  assert.equal(communityNotice({ 'msg-id': 'viewermilestone', 'msg-param-category': 'future-kind', 'msg-param-value': '7' }), undefined)
  assert.equal(communityNotice({ 'msg-id': 'raid' }), undefined)
  const announcement = communityNotice({ 'msg-id': 'announcement', 'msg-param-color': 'red;display:none', login: 'bad/login' })!
  assert.ok(announcement.kind === 'announcement'); assert.equal(announcement.color, 'PRIMARY'); assert.equal(announcement.login, '')
})

test('loyalty notices carry their authoritative values and localize their fallback', () => {
  const cases = [ ['viewermilestone', ';msg-param-category=watch-streak;msg-param-value=7', 'watch-streak', 7], ['bitsbadgetier', ';msg-param-threshold=10000', 'bits-badge', 10000], ['modiversary', ';msg-param-months=24', 'modiversary', 24] ] as const
  for (const [kind, tags, expected, value] of cases) {
    const notice = feed(kind, tags)[0].communityNotice!
    assert.equal(notice.kind, expected); assert.ok('value' in notice); assert.equal(notice.value, value)
  }
  setLocale('fr'); assert.match(feed('modiversary', ';msg-param-months=24')[0].text, /24 mois/)
  setLocale('en'); assert.match(feed('modiversary', ';msg-param-months=24')[0].text, /24 months/)
})

test('large Cheers use the authoritative total and bounded presentation thresholds', () => {
  for (const bits of [undefined, 0, -1000, 999, NaN, Infinity, 1000.5]) assert.equal(cheerEmphasis(bits), undefined)
  assert.equal(cheerEmphasis(1000), 'notable'); assert.equal(cheerEmphasis(4999), 'notable')
  assert.equal(cheerEmphasis(5000), 'large'); assert.equal(cheerEmphasis(9999), 'large')
  assert.equal(cheerEmphasis(10000), 'huge')
})
