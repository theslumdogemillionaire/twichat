import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'

/** Anything the window threw. Checked before the script may call itself a success. */
const rendererErrors: string[] = []

/**
 * Video pulled out of the room. We check what makes the feature: the window opens on the
 * right channel, the dock shrinks to an anchor that says where the picture went, all three
 * ways back bring it home, it follows the room like the dock did — next channel, stop on the
 * settings — it keeps no black margin around the picture, and the next launch reopens it on its
 * own, at the width, and pinned, the account left it.
 *
 * Nothing here needs a live channel: off air the player settles into a failure state, which
 * proves the same path. The margin check only has something to measure while playing, so it
 * runs on a live channel and steps aside otherwise. Playwright selectors stay French — the
 * smokes pin TWICHAT_LOCALE=fr.
 */
const channel = process.argv[2] ?? 'twitch'
// A second channel, only to check the window follows the room from one to the other.
const other = channel === 'twitch' ? 'zerator' : 'twitch'
const artifacts = resolve('artifacts')
await mkdir(artifacts, { recursive: true })
const data = resolve(tmpdir(), `twichat-detach-${process.pid}`)
await mkdir(data, { recursive: true })
await writeFile(resolve(data, 'preferences.json'), JSON.stringify({ channels: [], active: '', quality: '480p,best', playback: { buffer: 'balanced', autoplay: true } }))
const launch = () => electron.launch({ args: ['.'], env: { ...process.env, TWICHAT_LOCALE: 'fr', TWICHAT_TEST_DATA: data } })

/** Whether the video window is holding above the others. Only the main process knows. */
const playerPinned = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) =>
  BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('player.html'))?.isAlwaysOnTop() ?? null)

/** The video window geometry, as the main process sees it: the renderer never measures it. */
const playerBounds = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => {
  const target = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('player.html'))
  return target ? { ...target.getBounds(), content: target.getContentBounds() } : null
})

async function enterRoom(app: ElectronApplication) {
  const page = await app.firstWindow()
  page.on('pageerror', error => rendererErrors.push(error.message))
  await page.waitForFunction(() => document.body.dataset.ready === 'true')
  await page.getByRole('button', { name: /continuer en anonyme/i }).click()
  await page.waitForSelector('#app:not([hidden])')
  await page.locator('#add-room').click()
  await page.getByLabel('Nom de la chaîne', { exact: true }).fill(channel)
  await page.getByRole('button', { name: 'Rejoindre', exact: true }).click()
  await page.waitForSelector('#room-view:not([hidden])')
  return page
}

/** Detaches from the room and waits for the video window to answer on the right channel. */
async function detach(app: ElectronApplication, room: Page) {
  const opened = app.waitForEvent('window')
  await room.locator('#detach-stream').click()
  const page = await opened
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(name => document.querySelector('#detached-channel')?.textContent === `# ${name}`, channel, { timeout: 15000 })
  await room.waitForSelector('#detached-panel:not([hidden])')
  return page
}

const wanted = 900
const first = await launch()
let live = false
try {
  const room = await enterRoom(first)
  if (await room.locator('#video').getAttribute('controls') !== null) throw new Error('The dock video still carries the native controls.')
  const dockWidth = (await room.locator('#stream-dock').boundingBox())!.width
  await room.screenshot({ path: resolve(artifacts, 'detach-dock-attached.png') })

  const detachedPage = await detach(first, room)
  if (!detachedPage.url().endsWith('player.html')) throw new Error(`The detached window is not the video page: ${detachedPage.url()}`)
  if (!await room.locator('#detach-stream').isDisabled()) throw new Error('The detach button stays active while the video is already detached.')
  // Freeing the room is half the point: the dock has to give its width back to the chat.
  const anchorWidth = (await room.locator('#stream-dock').boundingBox())!.width
  if (anchorWidth >= dockWidth) throw new Error(`The dock kept the video's width once detached: ${anchorWidth} vs ${dockWidth}.`)
  await room.screenshot({ path: resolve(artifacts, 'detach-dock.png') })

  // The window asks for its stream on its own: waiting for it to settle proves `stream:resolve`
  // answers that window. On a live channel the state is EN DIRECT; off air, a failure state
  // makes the same point — the path is complete either way.
  await detachedPage.waitForFunction(() => document.querySelector('#detached-status')?.textContent !== 'CHARGEMENT', undefined, { timeout: 60000 })
  const playback = await detachedPage.locator('#detached-status').textContent()
  live = playback === 'EN DIRECT'
  await detachedPage.screenshot({ path: resolve(artifacts, 'detach-window.png') })
  console.log(`Detached player on #${channel}: ${playback} — ${await detachedPage.locator('#detached-error').textContent() || 'no error'}.`)

  // No black margin: the content is exactly the picture plus the control bar.
  if (live) {
    const frame = await detachedPage.evaluate(() => {
      const video = document.querySelector('video')!
      return { ratio: video.videoWidth / video.videoHeight, bar: Math.round(document.querySelector('.detached-bar')!.getBoundingClientRect().height) }
    })
    const content = (await playerBounds(first))!.content
    const expected = content.width / frame.ratio + frame.bar
    if (Math.abs(content.height - expected) > 3) throw new Error(`The video window leaves a margin: ${JSON.stringify(content)} for a ${frame.ratio.toFixed(3)} ratio and a ${frame.bar}px bar.`)
  }

  // Detaching moved the picture, not the player: the window has to follow the room the way
  // the dock did — the next channel, and the stop the settings page imposes.
  await room.locator('#add-room').click()
  await room.getByLabel('Nom de la chaîne', { exact: true }).fill(other)
  await room.getByRole('button', { name: 'Rejoindre', exact: true }).click()
  await detachedPage.waitForFunction(name => document.querySelector('#detached-channel')?.textContent?.endsWith(`# ${name}`), other, { timeout: 15000 })
  if (await room.locator('#detached-panel-channel').textContent() !== `# ${other}`) throw new Error('The room anchor kept naming the channel left behind.')
  await room.locator('#open-settings').click()
  await room.waitForSelector('#settings:not([hidden])')
  await room.locator('#detached-video').scrollIntoViewIfNeeded()
  await room.screenshot({ path: resolve(artifacts, 'detach-setting.png') })
  await detachedPage.waitForFunction(() => document.querySelector('#detached-status')?.textContent === 'À L’ARRÊT', undefined, { timeout: 15000 })
  await room.locator(`.room-button[data-channel="${channel}"]`).click()
  await room.waitForSelector('#room-view:not([hidden])')
  await detachedPage.waitForFunction(name => document.querySelector('#detached-channel')?.textContent?.endsWith(`# ${name}`), channel, { timeout: 15000 })

  // Pinned, the window holds above the others — and holds it across a restart.
  if (await playerPinned(first) !== false) throw new Error('The video window starts pinned.')
  await detachedPage.locator('#detached-pin').click()
  await room.waitForTimeout(300)
  if (await playerPinned(first) !== true) throw new Error('The pin button does not keep the window on top.')

  // The size given to the window is the heart of the request: it has to be remembered.
  await first.evaluate(({ BrowserWindow }, width) => {
    const target = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('player.html'))
    if (target) target.setBounds({ ...target.getBounds(), width })
  }, wanted)
  await room.waitForTimeout(700)

  // First way back: the window's own button.
  const closed = detachedPage.waitForEvent('close')
  await detachedPage.locator('#detached-attach').click()
  await closed
  await room.waitForSelector('#detached-panel', { state: 'hidden' })
  if (await room.locator('#detach-stream').isDisabled()) throw new Error('The detach button stays disabled after reattaching.')

  // Second way back: the anchor left in the room, which stays reachable even in chat-only mode.
  const anchored = await detach(first, room)
  await room.keyboard.press('Meta+Shift+V')
  await room.waitForSelector('#room-body.chat-only')
  if (!await room.locator('#attach-stream').isVisible()) throw new Error('Chat-only hides the anchor, leaving no way back to the video.')
  const bounds = await playerBounds(first)
  if (bounds?.width !== wanted) throw new Error(`The video window did not take its width back within the session: ${JSON.stringify(bounds)}`)
  const anchoredClosed = anchored.waitForEvent('close')
  await room.locator('#attach-stream').click()
  await anchoredClosed
  await room.keyboard.press('Meta+Shift+V')

  // Third way back: closing the window by hand means reattach — and puts the setting back with it.
  const again = await detach(first, room)
  await again.close()
  await room.waitForSelector('#detached-panel', { state: 'hidden' })
  if (await room.locator('#detached-video').isChecked()) throw new Error('Closing the window left the setting switched on.')

  // Left detached, the choice is what the next launch reads: the button and the setting are one.
  await detach(first, room)
  if (!await room.locator('#detached-video').isChecked()) throw new Error('Detaching did not switch the setting on.')
  await room.waitForTimeout(400)
} finally { await first.close() }

// The next session, on the same data directory: the choice, the pin and the width come back.
const second = await launch()
try {
  const room = await second.firstWindow()
  await room.waitForFunction(() => document.body.dataset.ready === 'true')
  const opened = second.waitForEvent('window')
  await room.getByRole('button', { name: /continuer en anonyme/i }).click()
  await room.waitForSelector('#app:not([hidden])')
  // Nothing is clicked here: the account left the video in its own window, so it opens there.
  const reopened = await opened
  await reopened.waitForFunction(() => document.querySelector('#detached-channel')?.textContent?.startsWith('#'), undefined, { timeout: 15000 })
  await room.waitForSelector('#detached-panel:not([hidden])')
  if (!await room.locator('#detached-video').isChecked()) throw new Error('The saved choice did not come back in the settings.')
  const bounds = await playerBounds(second)
  if (bounds?.width !== wanted) throw new Error(`The video window width did not survive the restart: ${JSON.stringify(bounds)}`)
  if (await playerPinned(second) !== true) throw new Error('The pin did not survive the restart.')
  // An uncaught exception in the window is a failure, whatever the assertions say: printing it
  // and passing let a broken renderer look like a green run.
  if (rendererErrors.length) throw new Error(`Renderer errors: ${rendererErrors.join(' | ')}`)
} finally { await second.close() }

console.log(`Detached video: window opened on #${channel}, dock reduced to its anchor, following the room from channel to channel and stopping on the settings, reattached from the window, from the anchor and by closing, ${live ? 'picture without margin, ' : ''}the account's choice reopening it on its own, pin and width ${wanted} kept from one session to the next.`)
