import { _electron as electron } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
/** Anything the window threw. Checked before the script may call itself a success. */
const rendererErrors: string[] = []

const channel = process.argv[2] ?? 'zerator'
// The buffering mode goes through the preferences file: every hls.js profile
// can therefore be checked on a real live stream, not only the default one.
const buffer = process.argv[3] ?? 'balanced'
const artifacts = resolve('artifacts')
await mkdir(artifacts, { recursive: true })
const data = resolve(tmpdir(), `twichat-video-${process.pid}`)
await mkdir(data, { recursive: true })
await writeFile(resolve(data, 'preferences.json'), JSON.stringify({ channels: [], active: '', quality: '480p,best', playback: { buffer, autoplay: true } }))
const app = await electron.launch({ args: ['.'], env: { ...process.env, TWICHAT_LOCALE: process.env.TWICHAT_LOCALE ?? 'fr', TWICHAT_TEST_DATA: data } })
app.process().stderr?.on('data', data => console.error(String(data)))
try {
  const page = await app.firstWindow()
  page.on('pageerror', error => rendererErrors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') console.error(`Console: ${message.text()}`) })
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => document.body.dataset.ready === 'true')
  const manifests = await page.evaluate(async ({ channel }) => {
    const results = []
    for (const quality of ['360p,worst', 'audio_only']) {
      const url = await window.twichat.resolveStream(channel, quality)
      const response = await fetch(url)
      results.push({ quality, url: new URL(url).protocol, status: response.status, body: (await response.text()).slice(0, 32) })
      await window.twichat.stopStream()
    }
    return results
  }, { channel })
  if (manifests.some(manifest => manifest.url !== 'twitch-media:' || manifest.status !== 200 || !manifest.body.startsWith('#EXTM3U'))) throw new Error(`Invalid HLS playlist: ${JSON.stringify(manifests)}`)
  await page.getByRole('button', { name: /continuer en anonyme/i }).click()
  await page.waitForSelector('#app:not([hidden])')
  await page.getByRole('button', { name: /rejoindre ma première chaîne/i }).click()
  await page.getByLabel('Nom de la chaîne', { exact: true }).fill(channel)
  await page.getByRole('button', { name: 'Rejoindre', exact: true }).click()
  await page.waitForFunction(() => ['EN DIRECT', 'INDISPONIBLE'].includes(document.querySelector('#player-status')?.textContent ?? ''), undefined, { timeout: 45000 })
  const state = await page.locator('#player-status').textContent()
  const detail = await page.locator('#video-error').textContent()
  await page.screenshot({ path: resolve(artifacts, 'video.png') })
  if (state !== 'EN DIRECT') throw new Error(`The player did not start: ${detail}`)
  // Fullscreen is checked on the window, not on `document.fullscreenElement`. Driven through
  // the debugging protocol, the document's own fullscreen state stops being updated on the way
  // out: `exitFullscreen()` never settles and no `fullscreenchange` is fired, while the window
  // does leave fullscreen — measured here, a second after the key. Used by hand the document
  // keeps up, so this is the harness reading a signal it cannot trust, not the player failing.
  const windowFullscreen = async (expected: boolean) => {
    for (let attempt = 0; attempt < 40; attempt++) {
      if (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isFullScreen() ?? false) === expected) return
      await page.waitForTimeout(250)
    }
    throw new Error(`The window never ${expected ? 'entered' : 'left'} fullscreen.`)
  }
  await page.getByRole('button', { name: 'Passer la vidéo en plein écran' }).click()
  await windowFullscreen(true)
  await page.keyboard.press('Escape')
  await windowFullscreen(false)
  console.log(`Twitch: video and audio playlists, autoplay and fullscreen validated on #${channel}, buffering "${buffer}".`)
  // An uncaught exception in the window is a failure, whatever the assertions say: printing it
  // and passing let a broken renderer look like a green run.
  if (rendererErrors.length) throw new Error(`Renderer errors: ${rendererErrors.join(' | ')}`)
} finally { await app.close() }
