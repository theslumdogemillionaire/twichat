import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DatabaseTooNew, openDatabase } from '../src/main/database'
import { ANONYMOUS_SCOPE, PreferencesStore, scopeName, validatePreferences } from '../src/main/preferences'
import { layoutPreferences, windowBounds } from '../src/shared/validation'

const base = { channels: [], active: '', quality: 'best' }
const store = async () => new PreferencesStore(join(await mkdtemp(join(tmpdir(), 'twichat-prefs-')), 'twichat.db'))

test('layout falls back on its defaults without ever rejecting the preferences', () => {
  const idle = { hideIdleChannels: true, idleChannelHours: 168 }
  assert.deepEqual(validatePreferences(base).layout, { playerWidth: 0, sidebarCollapsed: false, ...idle })
  assert.deepEqual(layoutPreferences({ playerWidth: 'large', sidebarCollapsed: 1 }), { playerWidth: 0, sidebarCollapsed: false, ...idle })
  assert.deepEqual(layoutPreferences({ playerWidth: 412.6, sidebarCollapsed: true }), { playerWidth: 413, sidebarCollapsed: true, ...idle })
  // A delay outside what the settings offer falls back on the default rather than folding the whole list away.
  assert.equal(layoutPreferences({ idleChannelHours: 0 }).idleChannelHours, 168)
  assert.equal(layoutPreferences({ idleChannelHours: 6 }).idleChannelHours, 6)
  assert.equal(layoutPreferences({ hideIdleChannels: false }).hideIdleChannels, false)
  // An absurd width is clamped into range rather than taking the rest of the file down with it.
  assert.equal(layoutPreferences({ playerWidth: 99_999 }).playerWidth, 4000)
  assert.equal(layoutPreferences({ playerWidth: -300 }).playerWidth, 0)
})

test('window geometry is clamped, and forgotten when it is incomplete', () => {
  assert.deepEqual(windowBounds({ width: 1400, height: 900, x: 20, y: 40 }), { width: 1400, height: 900, x: 20, y: 40, maximized: false })
  // A size below the window minimum is raised, not rejected.
  assert.deepEqual(windowBounds({ width: 100, height: 100, maximized: true }), { width: 760, height: 560, maximized: true })
  // A half-written position cannot place the window: only the size survives.
  assert.deepEqual(windowBounds({ width: 1000, height: 700, x: 12 }), { width: 1000, height: 700, maximized: false })
  assert.equal(windowBounds({ width: 'large', height: 700 }), undefined)
  assert.equal(validatePreferences({ ...base, window: { width: 0, height: 0 } }).window, undefined)
})

test('activity dates belong to one account and survive saving the rooms', async () => {
  const preferences = await store()
  await preferences.patch('zerator', current => ({ ...current, channels: ['zerator', 'twitch'], active: 'zerator' }))
  preferences.markChannelActivity('zerator', ['ZeRaTor', 'twitch'], 1_700_000_000_000)
  preferences.markChannelActivity('antoinedaniel', ['twitch'], 1_600_000_000_000)

  // Every save rewrites the room list whole: the dates must not go down with it.
  await preferences.patch('zerator', current => ({ ...current, channels: ['zerator', 'twitch', 'ponce'] }))
  assert.deepEqual(preferences.channelActivity('zerator'), { zerator: 1_700_000_000_000, twitch: 1_700_000_000_000 })
  assert.deepEqual(preferences.channelActivity('antoinedaniel'), { twitch: 1_600_000_000_000 })

  preferences.markChannelActivity('zerator', ['twitch'], 1_700_000_600_000)
  assert.equal(preferences.channelActivity('zerator').twitch, 1_700_000_600_000)
  // Forgetting an account takes its dates with it, the way the cascade takes its rooms.
  preferences.forget('zerator')
  assert.deepEqual(preferences.channelActivity('zerator'), {})
  preferences.close()
})

test('the idle setting round-trips through the database', async () => {
  const preferences = await store()
  await preferences.patch('zerator', current => ({ ...current, layout: { ...current.layout, hideIdleChannels: false, idleChannelHours: 720 } }))
  const written = await preferences.load('zerator')
  assert.equal(written.layout.hideIdleChannels, false)
  assert.equal(written.layout.idleChannelHours, 720)
  preferences.close()
})

test('the scope of an account-less session cannot be a Twitch login', () => {
  assert.equal(scopeName('ZeRaTor'), 'zerator')
  assert.equal(scopeName(null), ANONYMOUS_SCOPE)
  // `channelName` forbids `#`: no Twitch account can carry this key.
  assert.ok(ANONYMOUS_SCOPE.includes('#'))
})

test('what one account sets stays invisible from another', async () => {
  const preferences = await store()
  await preferences.patch('zerator', current => ({ ...current, channels: ['zerator', 'twitch'], active: 'twitch', theme: 'dark', layout: { ...current.layout, playerWidth: 520, sidebarCollapsed: true } }))
  await preferences.patch('antoinedaniel', current => ({ ...current, channels: ['antoinedaniel'], active: 'antoinedaniel', quality: 'audio_only' }))

  const first = await preferences.load('zerator')
  const second = await preferences.load('antoinedaniel')
  assert.deepEqual(first.channels, ['zerator', 'twitch'])
  assert.equal(first.theme, 'dark')
  assert.equal(first.layout.playerWidth, 520)
  assert.deepEqual(second.channels, ['antoinedaniel'])
  // Nothing from the first account crosses over: neither the rooms, nor the theme, nor the sizes.
  assert.equal(second.theme, 'system')
  assert.equal(second.layout.playerWidth, 0)
  assert.equal(second.quality, 'audio_only')
  // An account that never set anything starts from the defaults, not from its neighbor's.
  assert.deepEqual((await preferences.load(ANONYMOUS_SCOPE)).channels, [])
  assert.equal((await preferences.load(ANONYMOUS_SCOPE)).theme, 'system')
  preferences.close()
})

test('the room order of an account is the one it set', async () => {
  const preferences = await store()
  await preferences.patch('zerator', current => ({ ...current, channels: ['twitch', 'zerator', 'mistermv'] }))
  assert.deepEqual((await preferences.load('zerator')).channels, ['twitch', 'zerator', 'mistermv'])
  await preferences.patch('zerator', current => ({ ...current, channels: ['mistermv', 'twitch'] }))
  assert.deepEqual((await preferences.load('zerator')).channels, ['mistermv', 'twitch'])
  preferences.close()
})

test('a write from the renderer leaves the window geometry intact', async () => {
  const preferences = await store()
  await preferences.patch('zerator', current => ({ ...current, window: { width: 1400, height: 900, x: 30, y: 60, maximized: false } }))
  // The renderer sends complete preferences that are blind to the window: they must not erase it.
  const saved = await preferences.patch('zerator', current => ({
    ...validatePreferences({ ...base, channels: ['twitch'], active: 'twitch', layout: { playerWidth: 380, sidebarCollapsed: true } }),
    window: current.window
  }))
  assert.deepEqual(saved.window, { width: 1400, height: 900, x: 30, y: 60, maximized: false })
  assert.deepEqual(saved.layout, { playerWidth: 380, sidebarCollapsed: true, hideIdleChannels: true, idleChannelHours: 168 })
  assert.deepEqual((await preferences.load('zerator')).window, saved.window)
  preferences.close()
})

test('concurrent writes follow one another instead of overwriting each other', async () => {
  const preferences = await store()
  await Promise.all([
    preferences.patch('zerator', current => ({ ...current, layout: { ...current.layout, playerWidth: 320, sidebarCollapsed: false } })),
    preferences.patch('zerator', current => ({ ...current, window: { width: 1200, height: 800, maximized: true } }))
  ])
  await preferences.settled()
  const written = await preferences.load('zerator')
  assert.equal(written.layout.playerWidth, 320)
  assert.deepEqual(written.window, { width: 1200, height: 800, maximized: true })
  preferences.close()
})

test('a never-written scope returns complete preferences rather than missing values', async () => {
  const preferences = await store()
  const empty = await preferences.load('inconnu')
  assert.deepEqual(empty.layout, { playerWidth: 0, sidebarCollapsed: false, hideIdleChannels: true, idleChannelHours: 168 })
  assert.deepEqual(empty.playback, { buffer: 'balanced', autoplay: true, detached: false, volume: 1, muted: false })
  assert.deepEqual(empty.notifications, { mentions: true })
  preferences.close()
})

test('the last active scope is remembered for the next startup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twichat-prefs-'))
  const first = new PreferencesStore(join(directory, 'twichat.db'))
  assert.equal(first.lastScope(), null)
  first.rememberScope('zerator')
  await first.patch('zerator', current => ({ ...current, channels: ['twitch'] }))
  first.close()

  const second = new PreferencesStore(join(directory, 'twichat.db'))
  assert.equal(second.lastScope(), 'zerator')
  assert.deepEqual((await second.load('zerator')).channels, ['twitch'])
  second.close()
})

test('the rooms of a forgotten account go with it', async () => {
  const preferences = await store()
  await preferences.patch('zerator', current => ({ ...current, channels: ['twitch', 'mistermv'] }))
  preferences.forget('zerator')
  assert.deepEqual((await preferences.load('zerator')).channels, [])
  assert.deepEqual(preferences.scopes(), [])
  preferences.close()
})

test('the file from the previous version is imported into the named account, then set aside', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twichat-prefs-'))
  const legacy = join(directory, 'preferences.json')
  // The flat file from before per-account scoping: its rooms must not disappear.
  await writeFile(legacy, JSON.stringify({
    channels: ['zerator', 'mistermv'], active: 'mistermv', quality: '720p60,720p,best', theme: 'dark',
    layout: { playerWidth: 460, sidebarCollapsed: true }, window: { width: 1500, height: 950, x: 10, y: 20, maximized: false }
  }))
  const preferences = new PreferencesStore(join(directory, 'twichat.db'))
  const imported = await preferences.importLegacyFile(legacy, 'zerator')
  assert.deepEqual(imported?.channels, ['zerator', 'mistermv'])
  // The imported account becomes the last active one: the next startup opens on it.
  assert.equal(preferences.lastScope(), 'zerator')

  const restored = await preferences.load('zerator')
  assert.deepEqual(restored.channels, ['zerator', 'mistermv'])
  assert.equal(restored.active, 'mistermv')
  assert.equal(restored.theme, 'dark')
  assert.equal(restored.layout.playerWidth, 460)
  assert.deepEqual(restored.window, { width: 1500, height: 950, x: 10, y: 20, maximized: false })
  // The file is set aside, not deleted: the import stays verifiable.
  await assert.rejects(access(legacy))
  await access(`${legacy}.migrated`)
  // An already populated database imports nothing more: the import happens only once.
  assert.equal(await preferences.importLegacyFile(`${legacy}.migrated`, 'antoinedaniel'), null)
  preferences.close()
})

test('an unreadable file does not fail the import', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twichat-prefs-'))
  const legacy = join(directory, 'preferences.json')
  await writeFile(legacy, '{ pas du json')
  const preferences = new PreferencesStore(join(directory, 'twichat.db'))
  assert.equal(await preferences.importLegacyFile(legacy, 'zerator'), null)
  assert.deepEqual((await preferences.load('zerator')).channels, [])
  preferences.close()
})

test('a database a newer version wrote is refused rather than written into', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'twichat-newer-')), 'twichat.db')
  // Opened once at the revision this build knows, then stamped as if a later build had migrated it.
  openDatabase(path).close()
  const ahead = new DatabaseSync(path)
  ahead.exec('PRAGMA user_version = 99')
  ahead.close()
  // Reading a schema this build does not know means columns that may have moved and rows the
  // version that wrote them will read back wrong. Stopping is the only answer that does not damage
  // the data on the way past.
  assert.throws(() => openDatabase(path), (error: Error) => error instanceof DatabaseTooNew && error.found === 99 && error.known < 99)
})

test('a database at the revision this build knows opens without migrating anything', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'twichat-current-')), 'twichat.db')
  const first = openDatabase(path)
  const { user_version: version } = first.prepare('PRAGMA user_version').get() as { user_version: number }
  first.close()
  // The negative control for the refusal above: the same code path, one revision lower.
  const again = openDatabase(path)
  assert.equal((again.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, version)
  again.close()
})

test('forgetting an account takes its rooms, its activity and the pointer to it', async () => {
  const preferences = await store()
  await preferences.load('carol')
  await preferences.patch('carol', current => ({ ...current, channels: ['zerator', 'ponce'], active: 'ponce' }))
  preferences.markChannelActivity('carol', ['ponce'])
  preferences.rememberScope('carol')
  await preferences.settled()
  assert.equal(preferences.lastScope(), 'carol')
  assert.ok(preferences.scopes().includes('carol'))

  preferences.forget('carol')
  assert.ok(!preferences.scopes().includes('carol'))
  assert.deepEqual(preferences.channelActivity('carol'), {})
  // Left behind, the pointer would make the next launch load a scope that no longer exists and
  // build it again: an account asked to be forgotten, back as an empty one.
  assert.equal(preferences.lastScope(), null)
})
