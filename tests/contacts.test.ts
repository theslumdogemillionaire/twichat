import test from 'node:test'
import assert from 'node:assert/strict'
import { openDatabase } from '../src/main/database'
import { ContactStore } from '../src/main/contacts'

const store = () => new ContactStore(openDatabase(':memory:'))

test('someone added is kept for that account alone, with the day they were added', () => {
  const contacts = store()
  assert.equal(contacts.add('alice', { login: 'Cat_On_Keyboard', userId: '9', displayName: 'Cat_On_Keyboard' }, 1_757_160_000_000), true)
  assert.deepEqual(contacts.list('alice'), [
    { login: 'cat_on_keyboard', userId: '9', displayName: 'Cat_On_Keyboard', note: '', addedAt: 1_757_160_000_000 }
  ])
  assert.deepEqual(contacts.list('bob'), [])
})

test('adding someone twice refreshes what Twitch says and touches nothing else', () => {
  const contacts = store()
  contacts.add('alice', { login: 'cat_on_keyboard', userId: '9', displayName: 'Cat_On_Keyboard' }, 1000)
  contacts.note('alice', 'cat_on_keyboard', 'rencontrée chez studio_nova')
  // A rename on Twitch, and a second add long after: the note and the date must survive both.
  assert.equal(contacts.add('alice', { login: 'cat_on_keyboard', displayName: 'CatOnKeyboard' }, 9999), false)
  assert.deepEqual(contacts.list('alice'), [
    { login: 'cat_on_keyboard', userId: '9', displayName: 'CatOnKeyboard', note: 'rencontrée chez studio_nova', addedAt: 1000 }
  ])
})

test('a note is written, rewritten and cleared without the contact going anywhere', () => {
  const contacts = store()
  contacts.add('alice', { login: 'cat_on_keyboard' })
  contacts.note('alice', 'cat_on_keyboard', 'joue à des jeux de rythme')
  assert.equal(contacts.list('alice')[0].note, 'joue à des jeux de rythme')
  contacts.note('alice', 'cat_on_keyboard', '')
  assert.deepEqual(contacts.list('alice').map(one => [one.login, one.note]), [['cat_on_keyboard', '']])
})

test('a contact with no display name reads under their login', () => {
  const contacts = store()
  contacts.add('alice', { login: 'radio_ancienne' })
  assert.equal(contacts.list('alice')[0].displayName, 'radio_ancienne')
})

test('the address book reads in one order whatever order it was filled in', () => {
  const contacts = store()
  for (const login of ['radio_ancienne', 'atelier_synthe', 'cat_on_keyboard']) contacts.add('alice', { login })
  assert.deepEqual(contacts.list('alice').map(one => one.login), ['atelier_synthe', 'cat_on_keyboard', 'radio_ancienne'])
})

test('removing someone from the address book leaves the others where they were', () => {
  const contacts = store()
  contacts.add('alice', { login: 'cat_on_keyboard' })
  contacts.add('alice', { login: 'radio_ancienne' })
  contacts.remove('alice', 'cat_on_keyboard')
  assert.deepEqual(contacts.list('alice').map(one => one.login), ['radio_ancienne'])
})
