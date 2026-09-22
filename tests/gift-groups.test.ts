import test from 'node:test'
import assert from 'node:assert/strict'
import { TwitchIrc } from '../src/main/irc'
import { ChatStore, HISTORY_LIMIT } from '../src/renderer/chat-store'
import { giftIsForAccount, groupGiftMessages } from '../src/renderer/gift-groups'
import type { ChatEvent, ChatMessage } from '../src/shared/types'

function notice(id: string, kind = 'subgift', extra = '', time = 1000): ChatMessage {
  const irc = new TwitchIrc()
  let message!: ChatMessage
  irc.on('event', (event: ChatEvent) => { if (event.type === 'message') message = event.message })
  ;(irc as unknown as { handle(line: string): void }).handle(`@id=${id};msg-id=${kind};login=kvn664;display-name=Kvn664;msg-param-sub-plan=1000;msg-param-mass-gift-count=10;msg-param-recipient-user-name=${id};msg-param-recipient-display-name=${id};tmi-sent-ts=${time}${extra} :tmi.twitch.tv USERNOTICE #room`)
  return message
}

test('gift notices keep the actual donor, tier, recipient and gift duration', () => {
  const gift = notice('recipient', 'subgift', ';msg-param-recipient-display-name=ゆちゃまる;msg-param-gift-months=3').gift
  assert.deepEqual(gift, { kind: 'single', login: 'kvn664', displayName: 'Kvn664', anonymous: false, plan: '1000', count: 1, months: 3, recipient: { login: 'recipient', displayName: 'ゆちゃまる' } })
  const anonymous = notice('a', 'anonsubgift', ';login=somebody').gift!
  assert.equal(anonymous.login, '')
  assert.equal(anonymous.anonymous, true)
  assert.equal(notice('a', 'submysterygift', ';login=AnAnonymousGifter').gift!.anonymous, true)
  assert.equal(notice('a', 'submysterygift', ';msg-param-mass-gift-count=Infinity').gift!.count, null)
  assert.equal(notice('a', 'subgift', ';msg-param-recipient-user-name=bad/login').gift!.recipient!.login, '')
})

test('ten gifts become one card across an ordinary bot message; raw history remains intact', () => {
  const store = new ChatStore()
  const bundle = notice('bundle', 'submysterygift')
  const bot: ChatMessage = { ...notice('bot'), gift: undefined, system: false, user: 'StreamableRun', login: 'streamablerun', text: 'kvn664 just gifted 10 subscriptions to the community!' }
  store.add(bundle); store.add(bot)
  for (let i = 0; i < 10; i++) { const message = notice(`person${i}`); store.add(message); store.add(message) }
  assert.equal(store.get('room').length, 12)
  const shown = store.display('room')
  assert.equal(shown.length, 2)
  assert.equal(shown[1], bot)
  assert.equal(shown[0].giftRecipients!.length, 10)
  assert.equal(shown[0], store.display('room')[0], 'unchanged groups preserve row identity')
  assert.equal(bundle.giftRecipients, undefined, 'raw summary is never mutated')
  store.clear('room', undefined, 'person0:event')
  assert.equal(store.display('room')[0].giftRecipients!.length, 9)
  store.clear('room', undefined, 'bundle:event')
  assert.equal(store.display('room').length, 10, 'recipient notices survive removal of the summary')
})

test('only recent, matching, unambiguous gifts enter a bundle, up to its stated count', () => {
  const bundle = notice('bundle', 'submysterygift', ';msg-param-mass-gift-count=1')
  const first = notice('first')
  const cases = [
    notice('second'), notice('tier', 'subgift', ';msg-param-sub-plan=2000'),
    notice('donor', 'subgift', ';login=someone_else'), notice('late', 'subgift', '', 11_001),
    notice('earlier', 'subgift', '', 999), notice('months', 'subgift', ';msg-param-gift-months=3'),
    { ...notice('channel'), channel: 'another' }, notice('anon', 'anonsubgift')
  ]
  const shown = groupGiftMessages([bundle, first, ...cases])
  assert.equal(shown.length, cases.length + 1)
  assert.deepEqual(shown.slice(1), cases)
  assert.equal(shown[0].giftRecipients![0].login, 'first')
  const overlapping = notice('otherbundle', 'submysterygift')
  assert.equal(groupGiftMessages([bundle, overlapping, first]).length, 3)
})

test('an anonymous gift joins the anonymous bundle it belongs to, never a named one', () => {
  const bundle = notice('anonbundle', 'anonsubmysterygift', ';msg-param-mass-gift-count=1')
  const recipient = notice('anon', 'anonsubgift')
  const shown = groupGiftMessages([bundle, recipient])
  assert.equal(shown.length, 1)
  assert.equal(shown[0].giftRecipients![0].login, 'anon')
  assert.equal(groupGiftMessages([bundle, notice('named')]).length, 2, 'a named donor is not the anonymous one')
  assert.equal(groupGiftMessages([notice('bundle', 'submysterygift'), recipient]).length, 2)
  const twin = notice('twin', 'anonsubmysterygift', ';msg-param-mass-gift-count=1', 900)
  assert.equal(groupGiftMessages([bundle, twin, recipient]).length, 3, 'two overlapping anonymous batches stay apart')
})

test('new recipient arrivals update the existing card and evicted summaries lose no recipients', () => {
  const store = new ChatStore()
  store.add(notice('bundle', 'submysterygift'))
  const before = store.display('room')[0]
  store.add(notice('first'))
  const after = store.display('room')[0]
  assert.notEqual(after, before)
  assert.equal(after.id, before.id)
  assert.equal(after.gift, before.gift, 'animation identity survives the update')
  for (let i = 0; i < HISTORY_LIMIT - 1; i++) store.add({ ...notice(`chat${i}`), gift: undefined })
  assert.equal(store.display('room')[0].gift!.recipient!.login, 'first')
  store.reset()
  assert.deepEqual(store.display('room'), [])
})

test('personal gifts match the signed-in login, including a late recipient in a bundle', () => {
  const single = notice('my_login', 'subgift', ';msg-param-recipient-display-name=MonPseudo')
  assert.equal(giftIsForAccount(single, 'MY_LOGIN'), true)
  assert.equal(giftIsForAccount(single, 'MonPseudo'), false)
  assert.equal(giftIsForAccount(single, 'kvn664'), false, 'the donor is not the recipient')
  assert.equal(giftIsForAccount(single, null), false)
  const batch = notice('batch', 'submysterygift')
  assert.equal(giftIsForAccount(batch, 'my_login'), false)
  const grouped = groupGiftMessages([batch, notice('other'), single])[0]
  assert.equal(giftIsForAccount(grouped, 'my_login'), true)
  assert.equal(giftIsForAccount(notice('my_login', 'anonsubgift'), 'my_login'), true)
})
