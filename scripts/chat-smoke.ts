import { _electron as electron } from 'playwright'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
// The state comes from the catalog: a label that changes must not fail the test.
import { fr } from '../src/shared/i18n/fr'
/** Anything the window threw. Checked before the script may call itself a success. */
const rendererErrors: string[] = []

const channel = process.argv[2] ?? 'anyme023'
const artifacts = resolve('artifacts')
await mkdir(artifacts, { recursive: true })
const app = await electron.launch({ args: ['.'], env: { ...process.env, TWICHAT_LOCALE: process.env.TWICHAT_LOCALE ?? 'fr', TWICHAT_TEST_DATA: resolve(tmpdir(), `twichat-chat-${process.pid}`) } })
try {
  const page = await app.firstWindow()
  page.on('pageerror', error => rendererErrors.push(error.message))
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => document.body.dataset.ready === 'true')
  await page.getByRole('button', { name: /continuer en anonyme/i }).click()
  await page.waitForSelector('#app:not([hidden])')
  await page.getByRole('button', { name: /rejoindre ma première chaîne/i }).click()
  await page.getByLabel('Nom de la chaîne', { exact: true }).fill(channel)
  await page.getByRole('button', { name: 'Rejoindre', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('#connection-label')?.textContent === 'Chat connecté', undefined, { timeout: 15000 })
  await page.waitForSelector('.message', { timeout: 20000 })
  await page.waitForFunction(() => Number(document.querySelector('#message-count')?.textContent?.match(/\d+/)?.[0] ?? 0) >= 20, undefined, { timeout: 30000 })
  // Third-party packs arrive alongside chat; their absence must never block the room.
  await page.waitForSelector('.message-emote', { timeout: 12000 }).catch(() => {})
  const beforeTrip = await page.evaluate(() => Number(document.querySelector('#message-count')?.textContent?.match(/\d+/)?.[0] ?? 0))
  await page.getByRole('button', { name: /explorer les chaînes/i }).click()
  await page.waitForSelector('#discover:not([hidden])')
  await page.locator(`.room-button[data-channel="${channel}"]`).click()
  await page.waitForSelector('#room-view:not([hidden])')
  await page.waitForFunction(previous => Number(document.querySelector('#message-count')?.textContent?.match(/\d+/)?.[0] ?? 0) >= previous, beforeTrip)
  const result = await page.evaluate(() => ({
    count: document.querySelectorAll('.message').length,
    emptyHidden: (document.querySelector('#chat-empty') as HTMLElement)?.hidden,
    state: document.querySelector('#join-state')?.textContent,
    resumeHidden: (document.querySelector('#resume') as HTMLElement)?.hidden,
    distanceFromBottom: (() => { const log = document.querySelector('#chat-log') as HTMLElement; return Math.round(log.scrollHeight - log.scrollTop - log.clientHeight) })(),
    emotes: [...document.querySelectorAll<HTMLImageElement>('.message-emote')].map(image => image.title)
  }))
  if (!result.count || !result.emptyHidden || result.state !== fr.app.roomJoined || !result.resumeHidden || result.distanceFromBottom > 60) throw new Error(`Invalid chat display: ${JSON.stringify(result)}`)
  await page.screenshot({ path: resolve(artifacts, 'chat-live.png') })
  console.log(`Chat interface: anonymous messages shown on #${channel}; ${result.emotes.length} emote(s) visible${result.emotes.length ? ` (${result.emotes.slice(0, 5).join(', ')})` : ''}.`)
  // An uncaught exception in the window is a failure, whatever the assertions say: printing it
  // and passing let a broken renderer look like a green run.
  if (rendererErrors.length) throw new Error(`Renderer errors: ${rendererErrors.join(' | ')}`)
} finally { await app.close() }
