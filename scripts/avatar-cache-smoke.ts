import { _electron as electron } from 'playwright'
import { mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

/** Anything a window threw. Checked before the script may call itself a success. */
const rendererErrors: string[] = []

/**
 * The room pictures from one launch to the next, on the same data folder.
 *
 * A profile picture used to live in the main process's memory alone, so every start began with a
 * column of initials and stayed there whenever Twitch answered without one — a token dead
 * overnight, or an anonymous session, both of which leave the public page as the only source.
 * The check is therefore in two parts: the first launch has to leave the picture on disk, and the
 * second has to receive it in `app:init`, before anything is asked of Twitch.
 */
const artifacts = resolve('artifacts')
await mkdir(artifacts, { recursive: true })
const data = resolve(tmpdir(), `twichat-avatars-${process.pid}`)
const launch = () => electron.launch({ args: ['.'], env: { ...process.env, TWICHAT_LOCALE: process.env.TWICHAT_LOCALE ?? 'fr', TWICHAT_TEST_DATA: data } })

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
  await window.waitForSelector('.room-avatar img', { timeout: 15000 })
  // The download happens behind the room list; the file lands a moment after the picture shows.
  await window.waitForFunction(async () => Boolean((await (globalThis as any).twichat.init()).channelAvatars.twitch), null, { polling: 500, timeout: 15000 })
} finally { await first.close() }

const stored = JSON.parse(await readFile(join(data, 'channel-avatars.json'), 'utf8')) as Record<string, { source?: string; fetchedAt?: number; data?: string }>
const cached = stored.twitch
if (!cached?.source?.startsWith('https://static-cdn.jtvnw.net/')) throw new Error(`The cached picture does not come from the Twitch CDN: ${JSON.stringify(cached?.source)}`)
if (!cached.data?.startsWith('data:image/')) throw new Error(`The cached picture is not an image: ${JSON.stringify(cached.data?.slice(0, 40))}`)
if (typeof cached.fetchedAt !== 'number') throw new Error('The cached picture carries no date, so nothing would ever refetch it.')

const second = await launch()
try {
  const window = await second.firstWindow()
  window.on('pageerror', error => rendererErrors.push(error.message))
  await window.waitForFunction(() => document.body.dataset.ready === 'true')
  // What the window is handed at startup, before a single Twitch call has been made.
  const shipped = await window.evaluate(async () => (await (globalThis as any).twichat.init()).channelAvatars.twitch ?? '') as string
  if (shipped !== cached.data) throw new Error(`The startup snapshot does not carry the cached picture: ${JSON.stringify(shipped.slice(0, 40))}`)
  await window.getByRole('button', { name: /continuer en anonyme/i }).click()
  await window.waitForSelector('#app:not([hidden])')
  await window.waitForSelector('.room-avatar img', { timeout: 15000 })
  const painted = await window.evaluate(() => (document.querySelector('.room-avatar img') as HTMLImageElement | null)?.src ?? '')
  // Either source is a pass: the room draws the address Twitch names, and the cached picture
  // when it names none. An initial is the failure this whole file is about.
  if (!['https://static-cdn.jtvnw.net/', 'data:image/'].some(prefix => painted.startsWith(prefix))) {
    throw new Error(`The room came back to a bare initial: ${JSON.stringify(painted)}`)
  }
  await window.screenshot({ path: resolve(artifacts, 'avatar-cache.png') })
  if (rendererErrors.length) throw new Error(`Renderer errors: ${rendererErrors.join(' | ')}`)
} finally { await second.close() }

console.log(JSON.stringify({ cachedSource: cached.source, cachedBytes: cached.data.length, painted: 'ok' }))
