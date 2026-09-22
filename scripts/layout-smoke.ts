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

  // The room opens in a burst — profiles, emotes, badges, the stream resolved — and a drag started
  // inside it can have its pointer capture taken back before the gesture ends. Let it pass.
  await window.waitForTimeout(1500)
  const dockWidthNow = async () => Math.round((await window.locator('#stream-dock').boundingBox())!.width)
  const drag = async (handle: string, dx: number, dy: number) => {
    // Hovering first: the room is still settling its header and its picture when it opens, and a
    // box read a frame too early puts the press next to the handle rather than on it.
    await window.locator(handle).hover()
    const box = (await window.locator(handle).boundingBox())!
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    await window.mouse.move(x, y)
    await window.mouse.down()
    await window.mouse.move(x + dx, y + dy, { steps: 6 })
    await window.mouse.up()
  }

  // The bottom edge sets the same width through the 16:9 frame: a pixel of height is 16/9 of width.
  const beforeBottom = await dockWidthNow()
  await drag('#player-resizer-bottom', 0, 45)
  const afterBottom = await dockWidthNow()
  if (Math.abs(afterBottom - (beforeBottom + 45 * 16 / 9)) > 6) throw new Error(`Bottom edge did not follow the frame: ${beforeBottom} -> ${afterBottom}`)

  // The corner takes the axis that moved the most, so a diagonal pull grows the picture once.
  await drag('#player-resizer-corner', -70, 20)
  const afterCorner = await dockWidthNow()
  if (Math.abs(afterCorner - (afterBottom + 70)) > 6) throw new Error(`Corner drag did not resize the video: ${afterBottom} -> ${afterCorner}`)

  // Widest the room allows: the way out of the dock is said once, over the button that offers it.
  await drag('#player-resizer-corner', -900, 0)
  await window.waitForSelector('#detach-hint:not([hidden])', { timeout: 2000 })
  const placed = await window.evaluate(() => {
    const tip = document.querySelector('#detach-hint')!.getBoundingClientRect()
    const button = document.querySelector('#detach-stream')!.getBoundingClientRect()
    return { above: tip.bottom <= button.top, onIt: tip.left < button.left + button.width / 2 && tip.right > button.left }
  })
  if (!placed.above || !placed.onIt) throw new Error(`Detach hint misplaced: ${JSON.stringify(placed)}`)
  await window.locator('#detach-hint-dismiss').click()
  await window.waitForSelector('#detach-hint', { state: 'hidden' })
  // Said once and never again: the second time the picture is pushed to the edge, nothing appears.
  await drag('#player-resizer-corner', 120, 0)
  await drag('#player-resizer-corner', -900, 0)
  await window.waitForTimeout(250)
  if (!(await window.locator('#detach-hint').isHidden())) throw new Error('Detach hint shown twice.')
  // Back to the width the room opens with, so the rail below starts from where it always did.
  await window.locator('#player-resizer-corner').dblclick()

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
  // The hint is a fact about this install, not about the account: it survives the relaunch.
  const hintSeen = await window.evaluate(() => localStorage.getItem('twichat.detachHintSeen'))
  if (hintSeen !== '1') throw new Error(`Detach hint would be shown again: ${hintSeen}`)
  await window.screenshot({ path: resolve(artifacts, 'layout-restored.png') })
  console.log(JSON.stringify({ dockWidth, window: stored.window }))
  // An uncaught exception in the window is a failure, whatever the assertions say: printing it
  // and passing let a broken renderer look like a green run.
  if (rendererErrors.length) throw new Error(`Renderer errors: ${rendererErrors.join(' | ')}`)
} finally { await second.close() }
