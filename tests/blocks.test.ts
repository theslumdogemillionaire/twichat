import test from 'node:test'
import assert from 'node:assert/strict'
import { parseBlockedUsers } from '../src/main/blocks-parse'

// The shape Twitch documents for `helix/users/blocks`, one page of it.
const page = {
  data: [
    { user_id: '135093069', user_login: 'bluelava', display_name: 'BlueLava' },
    { user_id: '27419011', user_login: 'travistyoj', display_name: 'TravistyOJ' }
  ],
  pagination: { cursor: 'eyJiIjpudWxsLCJhIjp7Ik9mZnNldCI6NX19' }
}

test('reads a page of blocked users and the cursor that follows it', () => {
  const answer = parseBlockedUsers(page)
  assert.deepEqual(answer.users, [
    { login: 'bluelava', userId: '135093069', displayName: 'BlueLava' },
    { login: 'travistyoj', userId: '27419011', displayName: 'TravistyOJ' }
  ])
  assert.equal(answer.cursor, 'eyJiIjpudWxsLCJhIjp7Ik9mZnNldCI6NX19')
})

test('the last page carries no cursor, and neither does a payload that is not one', () => {
  assert.equal(parseBlockedUsers({ data: [], pagination: {} }).cursor, '')
  assert.deepEqual(parseBlockedUsers(null), { users: [], cursor: '' })
  assert.deepEqual(parseBlockedUsers({ data: 'nope' }), { users: [], cursor: '' })
  // A cursor is opaque, so its shape is all there is to check: anything longer is not one.
  assert.equal(parseBlockedUsers({ data: [], pagination: { cursor: 'a'.repeat(600) } }).cursor, '')
  assert.equal(parseBlockedUsers({ data: [], pagination: { cursor: '../../etc' } }).cursor, '')
})

test('an entry that could never hide anybody is dropped rather than repaired', () => {
  // The login is the key a chat message is compared against. Without a usable one — or without
  // the id a block is set by — the row would sit in the list doing nothing but inflating it.
  const answer = parseBlockedUsers({
    data: [
      { user_id: '1', user_login: 'nom invalide', display_name: 'Nope' },
      { user_id: 'not-a-number', user_login: 'someone', display_name: 'Nope' },
      { user_login: 'noid', display_name: 'Nope' },
      { user_id: '2', user_login: 'KeptButLowered' }
    ]
  })
  // Logins are lower case everywhere in this application; the display name falls back to it.
  assert.deepEqual(answer.users, [{ login: 'keptbutlowered', userId: '2', displayName: 'keptbutlowered' }])
})

test('a numeric id sent as a number is still an id', () => {
  // Twitch documents these as strings and sends them as strings, but the whole list would go
  // missing on the day one of them arrives unquoted.
  assert.deepEqual(parseBlockedUsers({ data: [{ user_id: 42, user_login: 'quarante', display_name: 'Quarante' }] }).users,
    [{ login: 'quarante', userId: '42', displayName: 'Quarante' }])
})
