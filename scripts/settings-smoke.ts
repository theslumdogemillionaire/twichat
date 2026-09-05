import { _electron as electron } from 'playwright'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'

/** Anything the window threw. Checked before the script may call itself a success. */
const rendererErrors: string[] = []

/**
 * Checks the settings on the Settings page that change how the application behaves:
 * video buffering, autoplay and mention notifications.
 * They must survive a restart, and autoplay turned off must leave
 * the player stopped when entering a room.
 */
const data = resolve(tmpdir(), `twichat-settings-${process.pid}`)
const launch = () => electron.launch({ args: ['.'], env: { ...process.env, TWICHAT_LOCALE: process.env.TWICHAT_LOCALE ?? 'fr', TWICHAT_TEST_DATA: data } })
const ANONYMOUS = '#anonymous'

/** What the database kept for an account: the settings row and its rooms, in order. */
function stored(scope: string) {
  const database = new DatabaseSync(resolve(data, 'twichat.db'))
  try {
    const row = database.prepare('SELECT * FROM scopes WHERE scope = ?').get(scope) as Record<string, unknown> | undefined
    const channels = (database.prepare('SELECT channel FROM scope_channels WHERE scope = ? ORDER BY position').all(scope) as { channel: string }[]).map(entry => entry.channel)
    return { row, channels }
  } finally { database.close() }
}

// The flat file from before per-account scoping: the app must carry it over, not ignore it.
await mkdir(data, { recursive: true })
await writeFile(resolve(data, 'preferences.json'), JSON.stringify({ channels: ['mistermv'], active: 'mistermv', quality: 'best', theme: 'dark' }))

const first = await launch()
try {
  const window = await first.firstWindow()
  window.on('pageerror', error => rendererErrors.push(error.message))
  await window.waitForFunction(() => document.body.dataset.ready === 'true')
  await window.getByRole('button', { name: /continuer en anonyme/i }).click()
  await window.waitForSelector('#app:not([hidden])')
  await window.getByRole('button', { name: /rejoindre une chaîne/i }).click()
  await window.getByLabel('Nom de la chaîne', { exact: true }).fill('twitch')
  await window.getByRole('button', { name: 'Rejoindre', exact: true }).click()
  await window.waitForSelector('#room-view:not([hidden])')
  await window.locator('#open-settings').click()
  await window.waitForSelector('#settings:not([hidden])')
  // The quality carried over from the flat file also shows in Settings, not only in the player.
  const restored = await window.locator('#preferred-quality').inputValue()
  if (restored !== 'best') throw new Error(`The carried-over quality does not reach Settings: ${restored}`)
  await window.locator('#preferred-quality').selectOption('720p60,720p,best')
  await window.locator('#buffer').selectOption('comfort')
  await window.locator('#autoplay').uncheck()
  await window.locator('#notify-mentions').uncheck()
  // The preferences write is deferred by 180 ms on the renderer side.
  await window.waitForTimeout(600)
} finally { await first.close() }

const saved = stored(ANONYMOUS)
if (saved.row?.buffer !== 'comfort' || saved.row?.autoplay !== 0) throw new Error(`Playback not saved: ${JSON.stringify(saved.row)}`)
if (saved.row?.quality !== '720p60,720p,best') throw new Error(`Video quality not saved: ${JSON.stringify(saved.row?.quality)}`)
if (saved.row?.notify_mentions !== 0) throw new Error(`Notifications not saved: ${JSON.stringify(saved.row)}`)
// The flat file is carried over: with no account stored on the device, it lands on the accountless session.
if (saved.row?.theme !== 'dark') throw new Error(`The theme from the carried-over file is lost: ${JSON.stringify(saved.row?.theme)}`)
if (saved.channels.join() !== 'mistermv,twitch') throw new Error(`Carried-over then joined rooms wrong: ${JSON.stringify(saved.channels)}`)
// Set aside rather than deleted, and so never read back a second time.
await access(resolve(data, 'preferences.json.migrated'))

// Another account puts its own rooms in the database: the accountless session must see none of them.
const database = new DatabaseSync(resolve(data, 'twichat.db'))
database.prepare(`INSERT INTO scopes (scope, active, updated_at) VALUES ('zerator', 'squeezie', 0)`).run()
database.prepare(`INSERT INTO scope_channels (scope, position, channel) VALUES ('zerator', 0, 'squeezie')`).run()
database.close()

const second = await launch()
try {
  const window = await second.firstWindow()
  window.on('pageerror', error => rendererErrors.push(error.message))
  await window.waitForFunction(() => document.body.dataset.ready === 'true')
  await window.getByRole('button', { name: /continuer en anonyme/i }).click()
  await window.waitForSelector('#app:not([hidden])')
  await window.locator('.room-button[data-channel="twitch"]').click()
  await window.waitForSelector('#room-view:not([hidden])')
  await window.waitForTimeout(1500)
  const status = (await window.locator('#player-status').textContent())?.trim() ?? ''
  if (!/arrêt/i.test(status)) throw new Error(`The stream started despite the setting: ${status}`)
  // A stopped player must not announce an autoplay the setting has just turned off.
  const placeholder = (await window.locator('#video-description').textContent()) ?? ''
  if (/automatiquement/i.test(placeholder)) throw new Error(`The player still announces an autoplay: ${placeholder}`)

  await window.locator('#account-button').click()
  await window.locator('#account-menu-settings').click()
  await window.waitForSelector('#settings:not([hidden])')
  const rooms = await window.evaluate(() => [...document.querySelectorAll<HTMLElement>('#rooms .room-button')].map(button => button.dataset.channel))
  if (rooms.includes('squeezie')) throw new Error(`Another account's rooms are visible: ${JSON.stringify(rooms)}`)
  if (!rooms.includes('twitch')) throw new Error(`This session's rooms are gone: ${JSON.stringify(rooms)}`)
  const controls = await window.evaluate(() => ({
    buffer: document.querySelector<HTMLSelectElement>('#buffer')?.value,
    quality: document.querySelector<HTMLSelectElement>('#preferred-quality')?.value,
    dockQuality: document.querySelector<HTMLSelectElement>('#quality')?.value,
    autoplay: document.querySelector<HTMLInputElement>('#autoplay')?.checked,
    mentions: document.querySelector<HTMLInputElement>('#notify-mentions')?.checked
  }))
  if (controls.buffer !== 'comfort' || controls.autoplay !== false || controls.mentions !== false) {
    throw new Error(`The controls do not pick up the settings: ${JSON.stringify(controls)}`)
  }
  // The quality picked in Settings is the same one the player holds: a single setting, two places.
  if (controls.quality !== '720p60,720p,best' || controls.dockQuality !== controls.quality) {
    throw new Error(`Video quality does not carry from one place to the other: ${JSON.stringify(controls)}`)
  }

  // And the other way round: set on the player, the quality must show in Settings. Autoplay
  // has been off since the first window, so nothing starts up again here.
  await window.locator('.room-button[data-channel="twitch"]').click()
  await window.waitForSelector('#room-view:not([hidden])')
  await window.locator('#quality').selectOption('360p,worst')
  await window.locator('#open-settings').click()
  await window.waitForSelector('#settings:not([hidden])')
  const mirrored = await window.locator('#preferred-quality').inputValue()
  if (mirrored !== '360p,worst') throw new Error(`Settings ignore the quality set on the player: ${mirrored}`)
} finally { await second.close() }

// The setting changed a fraction of a second before closing. The renderer defers its writes by
// 180 ms so that dragging a slider does not write once per pixel, and the window can close well
// inside that. The main process waits for the writes it has received and knows nothing of a
// timer still running in the window, so this last gesture used to be lost.
const third = await launch()
try {
  const window = await third.firstWindow()
  window.on('pageerror', error => rendererErrors.push(error.message))
  await window.waitForFunction(() => document.body.dataset.ready === 'true')
  await window.getByRole('button', { name: /continuer en anonyme/i }).click()
  await window.waitForSelector('#app:not([hidden])')
  await window.locator('#open-settings').click()
  await window.waitForSelector('#settings:not([hidden])')
  await window.locator('#autoplay').check()
  // No wait: the window goes away while the save is still only an appointment.
  await third.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())
  // An uncaught exception in the window is a failure, whatever the assertions say: printing it
  // and passing let a broken renderer look like a green run.
  if (rendererErrors.length) throw new Error(`Renderer errors: ${rendererErrors.join(' | ')}`)
} finally { await third.close() }

const onTheWayOut = stored(ANONYMOUS)
if (onTheWayOut.row?.autoplay !== 1) {
  throw new Error(`The setting changed just before closing was lost: ${JSON.stringify(onTheWayOut.row?.autoplay)}`)
}

console.log('Video quality, buffering, autoplay, notifications, flat-file carry-over, per-account scoping and the last change before closing verified.')
