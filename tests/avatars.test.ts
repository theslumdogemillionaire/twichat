import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AvatarStore } from '../src/main/avatars'

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const source = 'https://static-cdn.jtvnw.net/jtv_user_pictures/alice-profile_image-300x300.png'
function reply(body: Buffer, type = 'image/png', status = 200) {
  return new Response(new Uint8Array(body), { status, headers: { 'Content-Type': type, 'Content-Length': String(body.length) } })
}
async function directory(name: string) { return join(await mkdtemp(join(tmpdir(), `twichat-${name}-`)), 'avatars.json') }

test('remembers the avatar of an account and reads it back as a data URL', async () => {
  const path = await directory('avatars')
  const calls: string[] = []
  const avatars = new AvatarStore(path, async url => { calls.push(url); return reply(PNG) })

  await avatars.remember('Alice', source)
  assert.deepEqual(await avatars.all(), { alice: `data:image/png;base64,${PNG.toString('base64')}` })
  assert.equal(await avatars.fresh('ALICE'), true)
  assert.equal(await avatars.fresh('bob'), false)

  // A cached avatar is not downloaded again while it stays fresh.
  await avatars.remember('alice', source)
  assert.deepEqual(calls, [source])

  await avatars.forget('alice')
  assert.deepEqual(await avatars.all(), {})
})

test('refuses addresses outside the Twitch CDN, unexpected formats and sizes', async () => {
  const path = await directory('avatars-refus')
  const oversized = new AvatarStore(path, async () => reply(Buffer.alloc(300 * 1024)))
  await assert.rejects(oversized.remember('alice', source), /avatarTooLarge/)

  const wrongType = new AvatarStore(path, async () => reply(PNG, 'image/svg+xml'))
  await assert.rejects(wrongType.remember('alice', source), /avatarFormatUnsupported/)

  const missing = new AvatarStore(path, async () => reply(PNG, 'image/png', 404))
  await assert.rejects(missing.remember('alice', source), /avatarUnavailable/)

  const store = new AvatarStore(path, async () => reply(PNG))
  await assert.rejects(store.remember('alice', 'https://evil.example.com/avatar.png'), /avatarHostForbidden/)
  await assert.rejects(store.remember('alice', 'http://static-cdn.jtvnw.net/avatar.png'), /avatarHostForbidden/)
  assert.deepEqual(await store.all(), {})
})

test('ignores a corrupted cache instead of serving it to the renderer', async () => {
  const path = await directory('avatars-corrompu')
  await writeFile(path, JSON.stringify({
    alice: { source, fetchedAt: Date.now(), data: 'data:text/html;base64,PHNjcmlwdD4=' },
    bob: { source, fetchedAt: Date.now(), data: `data:image/png;base64,${PNG.toString('base64')}` },
    'nom invalide': { source, fetchedAt: Date.now(), data: `data:image/png;base64,${PNG.toString('base64')}` }
  }))
  const avatars = new AvatarStore(path, async () => reply(PNG))
  assert.deepEqual(Object.keys(await avatars.all()), ['bob'])
  await avatars.remember('alice', source)
  assert.deepEqual(Object.keys(await avatars.all()).sort(), ['alice', 'bob'])
  assert.doesNotMatch(await readFile(path, 'utf8'), /text\/html/)
})

test('two avatars cached at the same time both survive', async () => {
  // Same lost update as the account file: both calls read the state before either wrote it.
  const path = await directory('avatars-race')
  const avatars = new AvatarStore(path, async () => reply(PNG))
  const bobSource = source.replace('alice', 'bob')

  await Promise.all([avatars.remember('alice', source), avatars.remember('bob', bobSource)])

  assert.deepEqual(Object.keys(await avatars.all()).sort(), ['alice', 'bob'])
})
