import { _electron as electron } from 'playwright'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'

// The "followers" banner only opens with a signed-in account and a room that is genuinely closed:
// two conditions an automated check cannot bring together. What it checks is therefore the
// rest: the elements the renderer addresses by id exist, the room hides them at rest, and the
// layout holds once the banner is filled. The logic itself is covered offline
// by tests/follow-gate.test.ts.
const channel = process.argv[2] ?? 'anyme023'
const artifacts = resolve('artifacts')
await mkdir(artifacts, { recursive: true })
const app = await electron.launch({ args: ['.'], env: { ...process.env, TWICHAT_LOCALE: process.env.TWICHAT_LOCALE ?? 'fr', TWICHAT_TEST_DATA: resolve(tmpdir(), `twichat-follow-${process.pid}`) } })
const errors: string[] = []
try {
  const page = await app.firstWindow()
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => document.body.dataset.ready === 'true')
  await page.getByRole('button', { name: /continuer en anonyme/i }).click()
  await page.waitForSelector('#app:not([hidden])')
  await page.getByRole('button', { name: /rejoindre ma première chaîne/i }).click()
  await page.getByLabel('Nom de la chaîne', { exact: true }).fill(channel)
  await page.getByRole('button', { name: 'Rejoindre', exact: true }).click()
  await page.waitForSelector('#room-view:not([hidden])')

  const wiring = await page.evaluate(() => {
    const ids = ['composer-gate', 'composer-gate-title', 'composer-gate-detail', 'composer-gate-follow', 'composer-gate-recheck']
    return { missing: ids.filter(id => !document.getElementById(id)), hidden: (document.getElementById('composer-gate') as HTMLElement)?.hidden }
  })
  if (wiring.missing.length) throw new Error(`Banner incomplete: ${wiring.missing.join(', ')}`)
  // With no signed-in account, no room can demand a follow: the banner stays collapsed.
  if (wiring.hidden !== true) throw new Error('The "followers" banner shows with no signed-in account.')

  // The ROOMSTATE mode, on the other hand, comes from real chat and is read in the channel's side panel.
  await app.evaluate(({ BrowserWindow }, room) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('chat:events', [{ type: 'roomstate', channel: room, tags: { 'followers-only': '10' } }])
  }, channel)
  await page.waitForFunction(() => [...document.querySelectorAll('#room-modes .mode-tag')].some(tag => tag.textContent === 'Followers'))

  await page.evaluate(() => {
    const gate = document.getElementById('composer-gate') as HTMLElement
    document.getElementById('composer-gate-title')!.textContent = 'Encore 20 minutes avant de pouvoir écrire ici.'
    document.getElementById('composer-gate-detail')!.textContent = 'Vous suivez #chaine depuis 10 minutes, et cette chaîne en demande 30 minutes.'
    gate.hidden = false
  })
  await page.locator('#message-form').screenshot({ path: resolve(artifacts, 'follow-gate.png') })
  if (errors.length) throw new Error(`Renderer errors: ${errors.join(' | ')}`)
  console.log(`"followers" banner: elements present, collapsed with no account, mode read from ROOMSTATE on #${channel}.`)
} finally { await app.close() }
