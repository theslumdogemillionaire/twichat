import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AccountStore } from '../src/main/accounts'

/** A stand-in for the system keychain: the store only ever sees opaque text. */
const plainEncrypt = async (value: string) => Buffer.from(`secret:${value}`).toString('base64')
const plainDecrypt = async (value: string) => Buffer.from(value, 'base64').toString().replace(/^secret:/, '')

test('remembers, reads back and replaces accounts without writing the token in the clear', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twichat-accounts-'))
  const path = join(directory, 'accounts.json')
  const encrypt = async (value: string) => Buffer.from(`secret:${value}`).toString('base64')
  const decrypt = async (value: string) => Buffer.from(value, 'base64').toString().replace(/^secret:/, '')
  const accounts = new AccountStore(path, encrypt, decrypt)

  await accounts.save('Alice', 'token-one')
  await accounts.save('bob', 'token-two')
  await accounts.save('alice', 'token-new', 'refresh-new')

  assert.deepEqual(await accounts.list(), ['alice', 'bob'])
  assert.equal(await accounts.preferred(), 'alice')
  assert.equal(await accounts.token('ALICE'), 'token-new')
  assert.deepEqual(await accounts.credentials('ALICE'), { accessToken: 'token-new', refreshToken: 'refresh-new' })
  assert.doesNotMatch(await readFile(path, 'utf8'), /(?:token|refresh)-(?:one|two|new)/)
  await accounts.pauseAutoLogin()
  assert.equal(await accounts.preferred(), null)
  assert.deepEqual(await accounts.list(), ['alice', 'bob'])
  await accounts.select('bob')
  assert.equal(await accounts.preferred(), 'bob')
  await accounts.remove('alice')
  assert.deepEqual(await accounts.list(), ['bob'])
})

test('reads back accounts saved before OAuth refresh was added', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twichat-accounts-legacy-'))
  const path = join(directory, 'accounts.json')
  const encrypt = async (value: string) => Buffer.from(value).toString('base64')
  const decrypt = async (value: string) => Buffer.from(value, 'base64').toString()
  const accounts = new AccountStore(path, encrypt, decrypt)
  await writeFile(path, JSON.stringify({ accounts: [{ login: 'alice', secret: await encrypt('legacy-token') }], autoLogin: 'alice' }))
  assert.deepEqual(await accounts.credentials('alice'), { accessToken: 'legacy-token' })
})

test('two accounts saved at the same time both survive', async () => {
  // Read, modify, write: two calls that start together read the same state, and the second
  // write used to replace the first — one of the two accounts simply vanished.
  const directory = await mkdtemp(join(tmpdir(), 'twichat-accounts-race-'))
  const accounts = new AccountStore(join(directory, 'accounts.json'), plainEncrypt, plainDecrypt)

  await Promise.all([accounts.save('alice', 'token-one'), accounts.save('bob', 'token-two')])

  assert.deepEqual([...await accounts.list()].sort(), ['alice', 'bob'])
  assert.equal(await accounts.token('alice'), 'token-one')
  assert.equal(await accounts.token('bob'), 'token-two')
})

test('a removal and a sign-in that cross each other keep the state they agree on', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twichat-accounts-cross-'))
  const accounts = new AccountStore(join(directory, 'accounts.json'), plainEncrypt, plainDecrypt)
  await accounts.save('alice', 'token-one')

  // Issued in this order, they apply in this order: the queue never reorders them.
  await Promise.all([accounts.save('bob', 'token-two'), accounts.remove('alice')])
  assert.deepEqual(await accounts.list(), ['bob'])

  await Promise.all([accounts.save('carol', 'token-three'), accounts.pauseAutoLogin()])
  assert.deepEqual([...await accounts.list()].sort(), ['bob', 'carol'])
  assert.equal(await accounts.preferred(), null)
})
