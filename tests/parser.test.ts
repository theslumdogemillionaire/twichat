import test from 'node:test'
import assert from 'node:assert/strict'
import { IrcFramer, parseIrc, userNoticeSummary } from '../src/main/irc-parser'
import { setLocale } from '../src/shared/i18n'
// English is the default language since `en.ts` became the source of truth. The assertions
// below read the French catalog, so the language is pinned rather than inherited.
setLocale('fr')


test('parses IRCv3 tags, badges and content with spaces', () => {
  const message = parseIrc('@badge-info=subscriber\\s12;badges=moderator/1;color=#1E90FF;display-name=Alice\\sBob;id=42 :alice!alice@alice.tmi.twitch.tv PRIVMSG #salon :bonjour à tous')
  assert.ok(message)
  assert.equal(message.command, 'PRIVMSG')
  assert.deepEqual(message.params, ['#salon', 'bonjour à tous'])
  assert.equal(message.tags['display-name'], 'Alice Bob')
  assert.equal(message.prefix, 'alice!alice@alice.tmi.twitch.tv')
})

test('reassembles IRC frames received in several chunks', () => {
  const framer = new IrcFramer()
  assert.deepEqual(framer.push('PING :one\r'), [])
  assert.deepEqual(framer.push('\nPING :two\r\nPARTIAL'), ['PING :one', 'PING :two'])
  assert.deepEqual(framer.push('\r\n'), ['PARTIAL'])
})

test('ignores an empty line or one without a command', () => {
  assert.equal(parseIrc(''), null)
  assert.equal(parseIrc('@tags-only'), null)
})

test('summarizes subscription, gift and raid USERNOTICEs in French', () => {
  const notice = (raw: string) => userNoticeSummary(parseIrc(raw)!.tags)
  assert.equal(
    notice('@msg-id=resub;display-name=Alice;msg-param-cumulative-months=12;msg-param-sub-plan=2000;system-msg=Alice\\ssubscribed :tmi.twitch.tv USERNOTICE #salon :encore un an !'),
    'Alice se réabonne pour le 12ᵉ mois (niveau 2).')
  assert.equal(
    notice('@msg-id=sub;display-name=Bob;msg-param-sub-plan=Prime :tmi.twitch.tv USERNOTICE #salon'),
    'Bob vient de s’abonner (Prime).')
  assert.equal(
    notice('@msg-id=subgift;display-name=Bob;msg-param-sub-plan=1000;msg-param-recipient-display-name=Chloé :tmi.twitch.tv USERNOTICE #salon'),
    'Bob offre un abonnement niveau 1 à Chloé.')
  assert.equal(
    notice('@msg-id=submysterygift;display-name=Bob;msg-param-mass-gift-count=5 :tmi.twitch.tv USERNOTICE #salon'),
    'Bob offre 5 abonnements à la chaîne.')
  assert.equal(
    notice('@msg-id=raid;msg-param-displayName=Dora;msg-param-viewerCount=1 :tmi.twitch.tv USERNOTICE #salon'),
    'Dora débarque en raid avec 1 spectateur.')
  assert.equal(
    notice('@msg-id=viewermilestone;display-name=Eve;msg-param-category=watch-streak;msg-param-value=8 :tmi.twitch.tv USERNOTICE #salon'),
    'Eve suit 8 diffusions d’affilée.')
})

test('falls back to the Twitch system-msg for an unknown USERNOTICE', () => {
  const message = parseIrc('@msg-id=rewardgift;system-msg=Bob\\srewarded\\sthe\\schannel! :tmi.twitch.tv USERNOTICE #salon')!
  assert.equal(userNoticeSummary(message.tags), 'Bob rewarded the channel!')
  assert.equal(userNoticeSummary({}), '')
})
