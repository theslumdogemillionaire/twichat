import { _electron as electron } from 'playwright'
import { mkdir } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'

/** Anything the window threw. Checked before the script may call itself a success. */
const rendererErrors: string[] = []

/**
 * Checks what is expected from one launch to the next: the window and the video dock
 * take back the size the previous session left, on the same data folder.
 */
const artifacts = resolve('artifacts')
await mkdir(artifacts, { recursive: true })
const data = resolve(tmpdir(), `twichat-layout-${process.pid}`)
const launch = () => electron.launch({ args: ['.'], env: { ...process.env, TWICHAT_LOCALE: process.env.TWICHAT_LOCALE ?? 'fr', TWICHAT_TEST_DATA: data } })
const bounds = { width: 1180, height: 760 }

const first = await launch()
let dockWidth = 0
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

  const resizer = await window.locator('#player-resizer').boundingBox()
  if (!resizer) throw new Error('Resize handle missing.')
  await window.mouse.move(resizer.x + resizer.width / 2, resizer.y + resizer.height / 2)
  await window.mouse.down()
  await window.mouse.move(resizer.x - 90, resizer.y + resizer.height / 2)
  await window.mouse.up()
  await window.locator('#toggle-sidebar').click()
  dockWidth = Math.round((await window.locator('#stream-dock').boundingBox())!.width)

  // The second room, then back: the width set has to survive the room switch.
  await window.locator('#add-room').click()
  await window.getByLabel('Nom de la chaîne', { exact: true }).fill('busyroom')
  await window.getByRole('button', { name: 'Rejoindre', exact: true }).click()
  await window.waitForFunction(() => document.querySelector('#channel-title')?.textContent === 'busyroom')
  const switched = Math.round((await window.locator('#stream-dock').boundingBox())!.width)
  await window.locator('.room-button[data-channel="twitch"]').click()
  await window.waitForFunction(() => document.querySelector('#channel-title')?.textContent === 'twitch')
  const returned = Math.round((await window.locator('#stream-dock').boundingBox())!.width)
  if (Math.abs(switched - dockWidth) > 1 || Math.abs(returned - dockWidth) > 1) throw new Error(`Video width lost when switching rooms: ${dockWidth} -> ${switched} -> ${returned}`)

  await first.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setBounds(size), bounds)
  // Let the preferences debounce pass before closing.
  await window.waitForTimeout(700)
} finally { await first.close() }

// The settings live in the local database, with per-account scoping: here, the accountless session.
const database = new DatabaseSync(resolve(data, 'twichat.db'))
const stored = database.prepare(`SELECT player_width, sidebar_collapsed, window_width, window_height FROM scopes WHERE scope = '#anonymous'`).get() as Record<string, number> | undefined
database.close()
if (stored?.player_width !== dockWidth) throw new Error(`Video width not saved: ${JSON.stringify(stored)} for ${dockWidth}`)
if (stored?.sidebar_collapsed !== 1) throw new Error(`Sidebar not saved: ${JSON.stringify(stored)}`)
if (stored?.window_width !== bounds.width || stored?.window_height !== bounds.height) throw new Error(`Window not saved: ${JSON.stringify(stored)}`)

const second = await launch()
try {
  const window = await second.firstWindow()
  window.on('pageerror', error => rendererErrors.push(error.message))
  await window.waitForFunction(() => document.body.dataset.ready === 'true')
  const restored = await second.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getNormalBounds())
  if (restored.width !== bounds.width || restored.height !== bounds.height) throw new Error(`Window not restored: ${JSON.stringify(restored)}`)
  await window.getByRole('button', { name: /continuer en anonyme/i }).click()
  await window.waitForSelector('#room-view:not([hidden])')
  const layout = await window.evaluate(() => ({
    dock: Math.round(document.querySelector('#stream-dock')!.getBoundingClientRect().width),
    collapsed: document.querySelector('#app')!.classList.contains('sidebar-collapsed')
  }))
  if (Math.abs(layout.dock - dockWidth) > 1 || !layout.collapsed) throw new Error(`Layout not restored: ${JSON.stringify(layout)} for ${dockWidth}`)
  await window.screenshot({ path: resolve(artifacts, 'layout-restored.png') })
  console.log(JSON.stringify({ dockWidth, window: stored.window }))
  // An uncaught exception in the window is a failure, whatever the assertions say: printing it
  // and passing let a broken renderer look like a green run.
  if (rendererErrors.length) throw new Error(`Renderer errors: ${rendererErrors.join(' | ')}`)
} finally { await second.close() }
