import { _electron as electron } from 'playwright'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
/** Anything the window threw. Checked before the script may call itself a success. */
const rendererErrors: string[] = []

const channel = 'twichat_offline_probe'
const artifacts = resolve('artifacts')
await mkdir(artifacts, { recursive: true })
const app = await electron.launch({ args: ['.'], env: { ...process.env, TWICHAT_LOCALE: process.env.TWICHAT_LOCALE ?? 'fr', TWICHAT_TEST_DATA: resolve(tmpdir(), `twichat-lifecycle-${process.pid}`) } })
app.process().stderr?.on('data', data => console.error(String(data)))
try {
  const page = await app.firstWindow()
  page.on('pageerror', error => rendererErrors.push(error.message))
  page.on('close', () => console.error('The live stream lifecycle test window was closed.'))
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => document.body.dataset.ready === 'true')
  await page.getByRole('button', { name: /continuer en anonyme/i }).click()
  await page.getByRole('button', { name: /rejoindre ma première chaîne/i }).click()
  await page.getByLabel('Nom de la chaîne', { exact: true }).fill(channel)
  await page.getByRole('button', { name: 'Rejoindre', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('#player-status')?.textContent === 'HORS LIGNE', undefined, { timeout: 45000 })
  const offline = await page.locator('#video-error').textContent()
  if (!/Nouvelle vérification dans 15 s/i.test(offline ?? '')) throw new Error(`Incomplete offline state: ${offline}`)
  await page.screenshot({ path: resolve(artifacts, 'stream-offline.png') })
  await page.waitForFunction(() => document.querySelector('#player-status')?.textContent === 'RECONNEXION', undefined, { timeout: 20000 })
  await page.getByRole('button', { name: 'Arrêter le stream' }).click()
  await page.waitForFunction(() => document.querySelector('#player-status')?.textContent === 'À L’ARRÊT')
  await page.waitForTimeout(16000)
  if (await page.locator('#player-status').textContent() !== 'À L’ARRÊT') throw new Error('Monitoring continues after a manual stop.')
  console.log('Live stream lifecycle: offline, recheck and manual cancellation validated.')
  // An uncaught exception in the window is a failure, whatever the assertions say: printing it
  // and passing let a broken renderer look like a green run.
  if (rendererErrors.length) throw new Error(`Renderer errors: ${rendererErrors.join(' | ')}`)
} finally { await app.close() }
