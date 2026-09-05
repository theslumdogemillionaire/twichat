import { _electron as electron } from 'playwright'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
/** Anything the window threw. Checked before the script may call itself a success. */
const rendererErrors: string[] = []

const channel = process.argv[2] ?? 'theslumdogemillionaire'
const artifacts = resolve('artifacts')
await mkdir(artifacts, { recursive: true })
const app = await electron.launch({ args: ['.'], env: { ...process.env, TWICHAT_LOCALE: process.env.TWICHAT_LOCALE ?? 'fr', TWICHAT_TEST_DATA: resolve(tmpdir(), `twichat-reply-${process.pid}`) } })
try {
  const page = await app.firstWindow()
  page.on('pageerror', error => rendererErrors.push(error.message))
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => document.body.dataset.ready === 'true')
  await page.locator('#anonymous-session').click({ force: true })
  await page.waitForSelector('#app:not([hidden])')
  await page.getByRole('button', { name: /rejoindre ma première chaîne/i }).click({ force: true })
  await page.getByLabel('Nom de la chaîne', { exact: true }).fill(channel)
  await page.getByRole('button', { name: 'Rejoindre', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('#connection-label')?.textContent === 'Chat connecté', undefined, { timeout: 15000 })
  console.log(`Channel #${channel} joined. Waiting for a quoted reply…`)
  await page.waitForSelector('.message-quote', { timeout: 240000 })
  // The log is virtualized: read the rows present before they leave the DOM.
  await page.waitForTimeout(6000)
  const quotes = await page.evaluate(() => [...document.querySelectorAll('.message')].map(row => ({
    quoteUser: row.querySelector('.message-quote-user')?.textContent ?? null,
    quoteText: row.querySelector('.message-quote-text')?.textContent ?? null,
    user: row.querySelector('.message-user')?.textContent ?? '',
    body: (row.querySelector('.message-text') as HTMLElement)?.textContent ?? '',
    emotes: [...row.querySelectorAll<HTMLImageElement>('.message-text .message-emote')].map(image => image.alt)
  })).filter(row => row.quoteUser || row.emotes.length))
  console.log(JSON.stringify(quotes, null, 2))
  await page.screenshot({ path: resolve(artifacts, 'reply-thread.png') })
  console.log('Screenshot written to artifacts/reply-thread.png')
  // An uncaught exception in the window is a failure, whatever the assertions say: printing it
  // and passing let a broken renderer look like a green run.
  if (rendererErrors.length) throw new Error(`Renderer errors: ${rendererErrors.join(' | ')}`)
} finally { await app.close() }
