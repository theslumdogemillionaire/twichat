import { _electron as electron } from 'playwright'
import { mkdir } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'

/** Anything the window threw. Checked before the script may call itself a success. */
const rendererErrors: string[] = []

/**
 * Checks that the application really speaks two languages: what the main process resolves at
 * startup, what the HTML carries once hydrated, the hot switch from Settings, and that the
 * choice is stored on the account rather than in a setting shared by everyone.
 */
const data = resolve(tmpdir(), `twichat-locale-${process.pid}`)
const launch = (locale?: string) => electron.launch({
  args: ['.'],
  env: { ...process.env, TWICHAT_TEST_DATA: data, ...(locale ? { TWICHAT_LOCALE: locale } : {}) }
})

/** The visible text of the session gate, as a user reads it. */
const gateText = (page: Awaited<ReturnType<Awaited<ReturnType<typeof launch>>['firstWindow']>>) =>
  page.evaluate(() => document.querySelector('#session-gate')?.textContent?.replace(/\s+/g, ' ').trim() ?? '')

const FRENCH = /Comment voulez-vous entrer|Continuer en anonyme|Se connecter/
const ENGLISH = /How do you want to come in|Continue anonymously|Sign in/

const english = await launch('en')
try {
  const page = await english.firstWindow()
  page.on('pageerror', error => rendererErrors.push(error.message))
  await page.waitForFunction(() => document.body.dataset.ready === 'true')
  const text = await gateText(page)
  if (!ENGLISH.test(text)) throw new Error(`The session gate is not in English: ${text.slice(0, 120)}`)
  if (FRENCH.test(text)) throw new Error(`French text remains in the English locale: ${text.slice(0, 120)}`)
  // `lang` follows the language: hyphenation and screen readers depend on it.
  const lang = await page.evaluate(() => document.documentElement.lang)
  if (lang !== 'en') throw new Error(`The lang attribute reads "${lang}"`)
  // A translatable attribute, and a button where only part of the text is translated.
  const details = await page.evaluate(() => ({
    label: document.querySelector('#open-settings')?.getAttribute('aria-label'),
    join: document.querySelector('#add-room')?.textContent?.replace(/\s+/g, ' ').trim()
  }))
  if (details.label !== 'Settings') throw new Error(`aria-label not translated: ${details.label}`)
  if (!details.join?.includes('Join a channel')) throw new Error(`Icon button not translated: ${details.join}`)
} finally { await english.close() }

const french = await launch('fr')
try {
  const page = await french.firstWindow()
  page.on('pageerror', error => rendererErrors.push(error.message))
  await page.waitForFunction(() => document.body.dataset.ready === 'true')
  const text = await gateText(page)
  if (!FRENCH.test(text)) throw new Error(`The session gate is not in French: ${text.slice(0, 120)}`)

  // The switch from Settings, without a reload.
  await page.getByRole('button', { name: /continuer en anonyme/i }).click()
  await page.waitForSelector('#app:not([hidden])')
  await page.locator('#open-settings').click()
  await page.waitForSelector('#settings:not([hidden])')
  await page.locator('#language').selectOption('en')
  await page.waitForFunction(() => document.documentElement.lang === 'en', undefined, { timeout: 5000 })
  const switched = await page.evaluate(() => ({
    title: document.querySelector('#settings .discover-header h1')?.textContent,
    // A text painted by the script, not by hydration: it has to follow as well.
    empty: document.querySelector('#sidebar-empty')?.textContent?.replace(/\s+/g, ' ').trim(),
    player: document.querySelector('#player-status')?.textContent
  }))
  if (switched.title !== 'Settings') throw new Error(`Settings did not switch: ${switched.title}`)
  if (!switched.empty?.includes('in one place')) throw new Error(`The hydrated HTML did not follow: ${switched.empty}`)
  if (switched.player !== 'STOPPED') throw new Error(`The player was not repainted: ${switched.player}`)
  // The preferences write is deferred by 180 ms: the window must not close before that.
  await page.waitForTimeout(600)
  // An uncaught exception in the window is a failure, whatever the assertions say: printing it
  // and passing let a broken renderer look like a green run.
  if (rendererErrors.length) throw new Error(`Renderer errors: ${rendererErrors.join(' | ')}`)
} finally { await french.close() }

// The choice lives on the account, like the rest of the settings.
const database = new DatabaseSync(resolve(data, 'twichat.db'))
const row = database.prepare(`SELECT language FROM scopes WHERE scope = '#anonymous'`).get() as { language: string } | undefined
database.close()
if (row?.language !== 'en') throw new Error(`The language is not saved on the account: ${JSON.stringify(row)}`)

await mkdir(resolve('artifacts'), { recursive: true })
console.log('System language, hydration, hot switch and per-account persistence verified.')
