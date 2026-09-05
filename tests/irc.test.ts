import test from 'node:test'
import assert from 'node:assert/strict'
import { TwitchIrc } from '../src/main/irc'
import { messageFragments } from '../src/renderer/emotes'
import type { ChatEvent, ChatMessage } from '../src/shared/types'
import { setLocale } from '../src/shared/i18n'

// English is the default language since `en.ts` became the source of truth. The assertions
// below read the French catalog, so the language is pinned rather than inherited.
setLocale('fr')


// `handle` stays private: the test calls it directly to stay off the network.
function feed(...lines: string[]): ChatMessage[] {
  const irc = new TwitchIrc()
  const events: ChatEvent[] = []
  irc.on('event', (event: ChatEvent) => events.push(event))
  for (const line of lines) (irc as unknown as { handle(line: string): void }).handle(line)
  return events.flatMap(event => event.type === 'message' ? [event.message] : [])
}

test('publishes the event line then the viewer message for a resub', () => {
  const [event, chat] = feed('@msg-id=resub;id=abc;login=alice;display-name=Alice;color=#1E90FF;badges=subscriber/12;emotes=25:0-4;msg-param-cumulative-months=3;msg-param-sub-plan=1000;tmi-sent-ts=1700000000000;system-msg=Alice\\ssubscribed :tmi.twitch.tv USERNOTICE #salon :Kappa toujours là')
  assert.equal(event.system, true)
  assert.equal(event.channel, 'salon')
  assert.equal(event.text, 'Alice se réabonne pour le 3ᵉ mois (niveau 1).')
  assert.equal(event.time, 1700000000000)
  assert.equal(chat.system, undefined)
  assert.equal(chat.user, 'Alice')
  assert.equal(chat.login, 'alice')
  assert.equal(chat.text, 'Kappa toujours là')
  // The `emotes` offsets target the trailing alone: they stay valid because the two lines are distinct.
  assert.equal(chat.emotes, '25:0-4')
  assert.deepEqual(chat.badges, ['subscriber'])
  assert.notEqual(event.id, chat.id)
})

test('a raid without a message produces only the system line', () => {
  const messages = feed('@msg-id=raid;id=xyz;msg-param-displayName=Dora;msg-param-viewerCount=42 :tmi.twitch.tv USERNOTICE #salon')
  assert.equal(messages.length, 1)
  assert.equal(messages[0].text, 'Dora débarque en raid avec 42 spectateurs.')
  assert.equal(messages[0].system, true)
})

test('an announcement keeps its text attributed to its author', () => {
  const [event, chat] = feed('@msg-id=announcement;id=ann;login=mod;display-name=Mod;msg-param-color=PRIMARY :tmi.twitch.tv USERNOTICE #salon :le stream reprend dans 5 minutes')
  assert.equal(event.text, 'Annonce de Mod :')
  assert.equal(chat.text, 'le stream reprend dans 5 minutes')
  assert.equal(chat.user, 'Mod')
})

// Lines captured on #theslumdogemillionaire on 2026-09-04: the reply format comes from there.
const ROOT = '@badge-info=;badges=broadcaster/1;color=#DAA520;display-name=TheSlumdogeMillionaire;emote-only=1;emotes=emotesv2_5d523adb8bbb4786821cd7091e47da21:0-6;first-msg=0;id=6c0b1fff-86bb-4bab-a7f2-7d0d8532936f;mod=0;room-id=643143404;subscriber=0;tmi-sent-ts=1788563234315;turbo=0;user-id=643143404;user-type= :theslumdogemillionaire!theslumdogemillionaire@theslumdogemillionaire.tmi.twitch.tv PRIVMSG #theslumdogemillionaire :PopNemo'
const REPLY = '@badge-info=;badges=premium/1;color=#1E90FF;display-name=pixelpanda;emotes=;first-msg=0;id=faae351d-9e39-4e14-8724-138a4a81ca8d;mod=0;reply-parent-display-name=TheSlumdogeMillionaire;reply-parent-msg-body=PopNemo;reply-parent-msg-id=6c0b1fff-86bb-4bab-a7f2-7d0d8532936f;reply-parent-user-id=643143404;reply-parent-user-login=theslumdogemillionaire;reply-thread-parent-display-name=TheSlumdogeMillionaire;reply-thread-parent-msg-id=6c0b1fff-86bb-4bab-a7f2-7d0d8532936f;reply-thread-parent-user-id=643143404;reply-thread-parent-user-login=theslumdogemillionaire;room-id=643143404;tmi-sent-ts=1788563294199;user-id=100200300;user-type= :pixelpanda!pixelpanda@pixelpanda.tmi.twitch.tv PRIVMSG #theslumdogemillionaire :@TheSlumdogeMillionaire coucou'
const NESTED = '@badge-info=;badges=broadcaster/1;color=#DAA520;display-name=TheSlumdogeMillionaire;emotes=;first-msg=0;id=72369230-bf1d-441a-b4bd-bf85f574d712;mod=0;reply-parent-display-name=pixelpanda;reply-parent-msg-body=@TheSlumdogeMillionaire\\scoucou;reply-parent-msg-id=faae351d-9e39-4e14-8724-138a4a81ca8d;reply-parent-user-id=100200300;reply-parent-user-login=pixelpanda;reply-thread-parent-display-name=TheSlumdogeMillionaire;reply-thread-parent-msg-id=6c0b1fff-86bb-4bab-a7f2-7d0d8532936f;reply-thread-parent-user-id=643143404;reply-thread-parent-user-login=theslumdogemillionaire;room-id=643143404;tmi-sent-ts=1788563306770;user-id=643143404;user-type= :theslumdogemillionaire!theslumdogemillionaire@theslumdogemillionaire.tmi.twitch.tv PRIVMSG #theslumdogemillionaire :@pixelpanda réponse 1'

test('a plain message carries no quote', () => {
  const [message] = feed(ROOT)
  assert.equal(message.reply, undefined)
  assert.equal(message.text, 'PopNemo')
  assert.equal(message.emotes, 'emotesv2_5d523adb8bbb4786821cd7091e47da21:0-6')
})

test('a reply quotes its parent and drops the mention Twitch prefixes to the body', () => {
  const [message] = feed(REPLY)
  assert.equal(message.text, 'coucou')
  assert.deepEqual(message.reply, {
    id: '6c0b1fff-86bb-4bab-a7f2-7d0d8532936f',
    login: 'theslumdogemillionaire',
    user: 'TheSlumdogeMillionaire',
    text: 'PopNemo',
    threadId: '6c0b1fff-86bb-4bab-a7f2-7d0d8532936f',
    threadLogin: 'theslumdogemillionaire',
    threadUser: 'TheSlumdogeMillionaire'
  })
})

test('a parent that is not the thread root has its own mention stripped from the quote', () => {
  const [message] = feed(NESTED)
  assert.equal(message.text, 'réponse 1')
  // `reply-parent-msg-body` carries `@TheSlumdogeMillionaire `: the parent was itself a reply.
  assert.equal(message.reply?.text, 'coucou')
  assert.equal(message.reply?.id, 'faae351d-9e39-4e14-8724-138a4a81ca8d')
  // The thread root stays the very first message, not the immediate parent.
  assert.equal(message.reply?.threadId, '6c0b1fff-86bb-4bab-a7f2-7d0d8532936f')
})

// Captured on #zackrawrr: `@Kostanovi ` is 11 code points and `:D` is announced at 22-23,
// so Twitch counts offsets on the prefixed body, never on the message alone.
const REPLY_WITH_EMOTE = '@badge-info=;badges=;color=#FF4500;display-name=MartianMat6;emotes=555555560:22-23;first-msg=0;id=e3b48439-0cf9-4dc4-a8fc-d4136358a998;mod=0;reply-parent-display-name=Kostanovi;reply-parent-msg-body=@MartianMat6\\saction\\sgame;reply-parent-msg-id=17cab2de-1c51-4c21-ae23-eb811b760eca;reply-parent-user-id=137062866;reply-parent-user-login=kostanovi;reply-thread-parent-display-name=MartianMat6;reply-thread-parent-msg-id=e0af95a4-8f6c-4ce2-b16d-33b522b192af;reply-thread-parent-user-id=665760660;reply-thread-parent-user-login=martianmat6;room-id=552120296;tmi-sent-ts=1788564141209;user-id=665760660;user-type= :martianmat6!martianmat6@martianmat6.tmi.twitch.tv PRIVMSG #zackrawrr :@Kostanovi Thank you! :D'

test('emote offsets shift by the stripped mention', () => {
  const [message] = feed(REPLY_WITH_EMOTE)
  assert.equal(message.text, 'Thank you! :D')
  assert.equal(message.emotes, '555555560:11-12')
  assert.equal(Array.from(message.text).slice(11, 13).join(''), ':D')
  // The parent is not the thread root: its own mention disappears from the quote.
  assert.equal(message.reply?.text, 'action game')
  assert.equal(message.reply?.threadId, 'e0af95a4-8f6c-4ce2-b16d-33b522b192af')
})

test('a parent id that is not a Twitch message never reaches the IRC tag', () => {
  const lines: string[] = []
  const irc = new TwitchIrc()
  Object.assign(irc as unknown as Record<string, unknown>, {
    account: { login: 'pixelpanda', token: 'jeton' },
    socket: { readyState: 1, send: (line: string) => lines.push(line) }
  })
  irc.status = 'connected'
  irc.channels.add('salon')
  const parent = {
    id: '6c0b1fff-86bb-4bab-a7f2-7d0d8532936f', login: 'alice', user: 'Alice', text: 'coucou',
    threadId: '6c0b1fff-86bb-4bab-a7f2-7d0d8532936f', threadLogin: 'alice', threadUser: 'Alice'
  }
  irc.send('salon', 'me voilà', parent)
  assert.equal(lines.at(-1)?.trimEnd(), '@reply-parent-msg-id=6c0b1fff-86bb-4bab-a7f2-7d0d8532936f PRIVMSG #salon :me voilà')

  irc.status = 'connected'
  Object.assign(irc as unknown as Record<string, unknown>, { sent: [] })
  irc.send('salon', 'sans parent', { ...parent, id: 'x\r\nJOIN #ailleurs' })
  assert.equal(lines.at(-1)?.trimEnd(), 'PRIVMSG #salon :sans parent')
})

test('a non-Latin display name is prefixed by its login, and the mention still drops', () => {
  // Twitch then prefixes the body with the ASCII login, not the display name: without that
  // switch, the received text differs from the local echo and the sender would see their own message twice.
  const [message] = feed('@display-name=Bob;emotes=555555560:13-14;id=48e2910a-9c19-4552-b4c9-c80e7c39b60e;reply-parent-display-name=\u3070\u3093\u3073;reply-parent-msg-body=yo;reply-parent-msg-id=6c0b1fff-86bb-4bab-a7f2-7d0d8532936f;reply-parent-user-login=bambi;reply-thread-parent-msg-id=6c0b1fff-86bb-4bab-a7f2-7d0d8532936f;tmi-sent-ts=1788563294199 :bob!bob@bob.tmi.twitch.tv PRIVMSG #salon :@bambi salut :D')
  assert.equal(message.text, 'salut :D')
  assert.equal(message.emotes, '555555560:6-7')
  assert.equal(message.reply?.user, '\u3070\u3093\u3073')
})

// Line captured on #theslumdogemillionaire: a reply carrying a real Twitch emote,
// whose offsets 24-30 target `WutFace` inside `@TheSlumdogeMillionaire WutFace`.
test('a Twitch emote in a reply arrives intact all the way to the renderer', () => {
  const [message] = feed('@color=#1E90FF;display-name=pixelpanda;emotes=28087:24-30;id=b8a59673-47e6-4382-88b9-a38f27d04277;reply-parent-display-name=TheSlumdogeMillionaire;reply-parent-msg-body=@pixelpanda\\soooh,\\set\\sune\\sautre\\semote\\smonkaS;reply-parent-msg-id=745f148d-7cd8-41dc-be80-c34a96163d01;reply-parent-user-login=theslumdogemillionaire;reply-thread-parent-display-name=pixelpanda;reply-thread-parent-msg-id=7d7614e0-27b2-4e1c-898a-8495422dfb8c;reply-thread-parent-user-login=pixelpanda;tmi-sent-ts=1788564338445 :pixelpanda!pixelpanda@pixelpanda.tmi.twitch.tv PRIVMSG #theslumdogemillionaire :@TheSlumdogeMillionaire WutFace')
  assert.equal(message.text, 'WutFace')
  assert.equal(message.emotes, '28087:0-6')
  assert.equal(message.reply?.text, 'oooh, et une autre emote monkaS')
  const fragments = messageFragments(message.text, message.emotes)
  assert.deepEqual(fragments, [{ type: 'emote', id: '28087', text: 'WutFace', url: 'https://static-cdn.jtvnw.net/emoticons/v2/28087/default/dark/2.0', source: 'twitch' }])
})

// The "follow this channel" banner is driven by these two lines: the account badges say who
// can write despite the mode, and `msg-id` survives translations of the refusal text.
test('remembers the account badges room by room and keeps the id of a NOTICE', () => {
  const irc = new TwitchIrc()
  const events: ChatEvent[] = []
  irc.on('event', (event: ChatEvent) => events.push(event))
  const push = (line: string) => (irc as unknown as { handle(line: string): void }).handle(line)
  irc.join('salon')
  push('@badges=moderator/1,subscriber/12;color=#1E90FF;display-name=Alice :tmi.twitch.tv USERSTATE #salon')
  assert.deepEqual(irc.userBadges.get('salon'), ['moderator', 'subscriber'])
  assert.deepEqual(events.filter(event => event.type === 'userstate'), [{ type: 'userstate', channel: 'salon', badges: ['moderator', 'subscriber'] }])

  push('@msg-id=msg_followersonly :tmi.twitch.tv NOTICE #salon :This room is in 10 minute followers-only mode.')
  const [refusal] = events.flatMap(event => event.type === 'message' ? [event.message] : [])
  assert.equal(refusal.system, true)
  assert.equal(refusal.notice, 'msg_followersonly')

  // A forged `msg-id` does not travel on to the renderer as is.
  push('@msg-id=<script> :tmi.twitch.tv NOTICE #salon :Information Twitch')
  assert.equal(events.flatMap(event => event.type === 'message' ? [event.message] : []).at(-1)?.notice, undefined)

  // Badges belong to the account: switching sessions must not leave the previous account's badges behind.
  irc.logout(false)
  assert.equal(irc.userBadges.size, 0)
})

// The example of the Twitch documentation, replayed as a line: the body carries the title of
// the GIF, and the `gifs` tag the address GIPHY serves it from.
const GIF_URL = 'https://media4.giphy.com/media/joSNxeswxuc74Juo8X/giphy.gif?cid=095d7a5d&ep=v1_gifs_trending&rid=giphy.gif&ct=g'
const GIF = `@badge-info=subscriber/30;badges=broadcaster/1,subscriber/0;color=#033700;display-name=TwitchDev;emotes=;first-msg=0;gifs=0-33|joSNxeswxuc74Juo8X|${GIF_URL};id=401abf17-7e99-45d6-9bdf-43934e839327;mod=0;room-id=12826;subscriber=1;tmi-sent-ts=1783632907018;turbo=0;user-id=141981764;user-type= :twitchdev!twitchdev@twitchdev.tmi.twitch.tv PRIVMSG #twitch :[Y A Y Yes GIF by Djemilah Birnie]`
const GIF_REPLY = `@badge-info=;badges=;color=;display-name=TwitchDev;emotes=;gifs=7-40|joSNxeswxuc74Juo8X|${GIF_URL};id=401abf17-7e99-45d6-9bdf-43934e839328;mod=0;reply-parent-display-name=Alice;reply-parent-msg-body=coucou;reply-parent-msg-id=6c0b1fff-86bb-4bab-a7f2-7d0d8532936f;reply-parent-user-login=alice;room-id=12826;tmi-sent-ts=1783632907019;user-id=141981764;user-type= :twitchdev!twitchdev@twitchdev.tmi.twitch.tv PRIVMSG #twitch :@Alice [Y A Y Yes GIF by Djemilah Birnie]`

test('the GIF of a message reaches the renderer as its own fragment', () => {
  const [message] = feed(GIF)
  assert.equal(message.text, '[Y A Y Yes GIF by Djemilah Birnie]')
  assert.equal(message.gifs, `0-33|joSNxeswxuc74Juo8X|${GIF_URL}`)
  assert.deepEqual(messageFragments(message.text, message.emotes, undefined, undefined, message.gifs), [
    { type: 'gif', id: 'joSNxeswxuc74Juo8X', text: message.text, url: GIF_URL }
  ])
})

test('the offsets of a GIF shift by the stripped mention, address untouched', () => {
  const [message] = feed(GIF_REPLY)
  assert.equal(message.text, '[Y A Y Yes GIF by Djemilah Birnie]')
  // `@Alice ` is 7 code points: the range announced at 7-40 lands back on the whole body.
  assert.equal(message.gifs, `0-33|joSNxeswxuc74Juo8X|${GIF_URL}`)
  assert.equal(message.reply?.text, 'coucou')
})

test('a message without a GIF carries no tag for one', () => {
  const [message] = feed(ROOT)
  assert.equal(message.gifs, undefined)
})
