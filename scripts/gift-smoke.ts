import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { TwitchIrc } from '../src/main/irc'
import { setLocale } from '../src/shared/i18n'
import type { ChatEvent } from '../src/shared/types'

// Reproduce the screenshot with simulated IRC notices. Nothing is sent to Twitch.
const locale = process.argv[2] === 'en' ? 'en' : 'fr'
setLocale(locale)
const channel = 'twichat_gift_test'
const artifacts = resolve('artifacts')
await mkdir(artifacts, { recursive: true })
const app = await electron.launch({ args: ['.'], env: { ...process.env, TWICHAT_LOCALE: locale, TWICHAT_TEST_DATA: resolve(tmpdir(), `twichat-gifts-${process.pid}`) } })
const errors: string[] = []
const sprite = `data:image/png;base64,${(await readFile(resolve('server/demo-assets/avatar-sprite.png'))).toString('base64')}`
try {
  const page = await app.firstWindow()
  page.on('pageerror', error => errors.push(error.message))
  // Existing demo portraits are test fixtures, not the real recipients' profile pictures.
  const portraits = await page.evaluate(async source => {
    const image = new Image(); image.src = source; await image.decode()
    return Array.from({ length: 12 }, (_, i) => {
      const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64
      canvas.getContext('2d')!.drawImage(image, (i % 4) * image.width / 4, Math.floor(i / 4) * image.height / 3, image.width / 4, image.height / 3, 0, 0, 64, 64)
      return canvas.toDataURL()
    })
  }, sprite)
  await app.evaluate(({ ipcMain }, portraits) => {
    ipcMain.removeHandler('rooms:profiles')
    ipcMain.handle('rooms:profiles', async (_event, channels: string[]) => channels.map(channel => ({ channel, displayName: channel, avatarUrl: portraits[Array.from(channel).reduce((sum, char) => sum + char.charCodeAt(0), 0) % portraits.length], live: false })))
    ipcMain.removeHandler('chatters:profiles')
    ipcMain.handle('chatters:profiles', async (_event, channels: string[]) => channels.map(channel => ({ channel, displayName: channel, avatarUrl: portraits[Array.from(channel).reduce((sum, char) => sum + char.charCodeAt(0), 0) % portraits.length], live: false })))
    ipcMain.removeHandler('account:authenticate')
    ipcMain.handle('account:authenticate', async () => 'davloire')
  }, portraits)
  await page.waitForFunction(() => document.body.dataset.ready === 'true')
  await page.locator('#anonymous-session').click()
  await page.waitForSelector('#app:not([hidden])')
  await page.locator('#welcome-add').click()
  await page.locator('#channel-input').fill(channel)
  await page.locator('#join-form button[type=submit]').click()
  await page.waitForSelector('#room-view:not([hidden])')
  if (await page.locator('#toggle-player').getAttribute('aria-pressed') === 'false') await page.locator('#toggle-player').click()
  async function publish(lines: string[]) {
    const irc = new TwitchIrc()
    const events: ChatEvent[] = []
    irc.on('event', event => events.push(event))
    for (const line of lines) (irc as unknown as { handle(line: string): void }).handle(line)
    await app.evaluate(({ BrowserWindow }, events) => BrowserWindow.getAllWindows()[0].webContents.send('chat:events', events), events)
  }
  const now = Date.now()
  const gift = (id: string, type: string, extra = '') => `@id=${id};msg-id=${type};login=kvn664;display-name=kvn664;msg-param-sub-plan=1000;tmi-sent-ts=${now}${extra} :tmi.twitch.tv USERNOTICE #${channel}`
  const recipients = ['FlanaDev', 'Hennala', 'Frank1e420', 'ゆちゃまる', 'Juustosampyla', 'sesenaapi', 'Rio_Nova', 'ZeeLogg', 'Digger_Dingo', 'davloire']
  const recipient = (name: string, i: number) => gift(`gift-${i}`, 'subgift', `;msg-param-recipient-user-name=${i === 3 ? 'yuchamaru' : name.toLowerCase()};msg-param-recipient-display-name=${name}`)
  const bundle = gift('bundle', 'submysterygift', ';msg-param-mass-gift-count=10')
  await publish([bundle, `@id=bot;display-name=StreamableRun :streamablerun!streamablerun@streamablerun.tmi.twitch.tv PRIVMSG #${channel} :kvn664 just gifted 10 subscriptions to the community!`])
  const card = page.locator('[data-id="bundle:event"]')
  await card.waitFor()
  assert.equal(await card.locator('.gift-arriving').count(), 1)
  // Deliver recipients later, across multiple UI batches, to exercise row replacement.
  await publish(recipients.slice(0, 5).map(recipient))
  await page.waitForFunction(() => document.querySelectorAll('.gift-recipient').length === 5)
  assert.equal(await card.locator('.gift-arriving').count(), 0)
  await publish(recipients.slice(5).map((name, i) => recipient(name, i + 5)))
  await card.locator('.gift-expand').waitFor()
  assert.equal(await card.locator('.gift-recipient').count(), 8)
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('.gift-avatar img')].length === 8 && [...document.querySelectorAll<HTMLImageElement>('.gift-avatar img')].every(image => image.naturalWidth > 0))
  assert.equal(await card.locator('[data-card="yuchamaru"]').getAttribute('title'), 'ゆちゃまる')
  await publish([bundle, recipient(recipients[0], 0)])
  assert.equal(await page.locator('.gift-card').count(), 1)
  assert.equal(await page.locator('[data-id="bot"] .message-text').textContent(), 'kvn664 just gifted 10 subscriptions to the community!')
  assert.equal(await page.locator('.message[data-id^="gift-"]').count(), 0, 'individual gift notices are inside the bundle')
  await page.mouse.move(0, 0)
  await page.waitForFunction(() => (document.querySelector('#user-card') as HTMLElement).hidden)
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme }, theme)
    await page.locator('#chat-log').screenshot({ path: resolve(artifacts, `gifts-${locale}-${theme}.png`) })
    await card.locator('.gift-card').screenshot({ path: resolve(artifacts, `gift-card-${locale}-${theme}.png`) })
  }
  await card.locator('.gift-expand').click()
  assert.equal(await card.locator('.gift-recipient').count(), 10)
  await card.locator('[data-card="yuchamaru"]').focus()
  await page.keyboard.press('Enter')
  await page.waitForSelector('#user-card:not([hidden])')
  assert.equal((await page.locator('#channel-title').textContent())?.toLowerCase(), channel)
  await page.keyboard.press('Escape')
  await card.locator('.gift-expand').click()
  assert.equal(await card.locator('.gift-recipient').count(), 8)
  // Sign in through the regular UI against a test-only handler: no real account or token.
  await page.locator('#composer-login').click()
  await page.locator('.manual-auth summary').click()
  await page.locator('#token-input').fill('test-fixture')
  await page.locator('#auth-submit').click()
  await card.locator('.gift-tag').waitFor()
  assert.match(await card.locator('.gift-tag').innerText(), /Tu as reçu un abonnement|You received a subscription/)
  assert.equal(await card.locator('.gift-tag .gift-avatar').getAttribute('data-card'), 'davloire')
  await page.mouse.move(0, 0)
  await card.locator('.gift-card').screenshot({ path: resolve(artifacts, `gift-personal-${locale}.png`) })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await publish([
    gift('isolated', 'subgift', ';login=another_gifter;display-name=UneTrèsLongueCommunautéQuiOffreUnAbonnement;msg-param-recipient-user-name=flanadev;msg-param-recipient-display-name=FlanaDev;msg-param-sub-plan=2000;msg-param-gift-months=3'),
    gift('anonymous', 'anonsubgift', ';msg-param-recipient-user-name=davloire;msg-param-recipient-display-name=davloire')
  ])
  await page.locator('[data-id="anonymous:event"]').waitFor()
  assert.equal(await page.locator('[data-id="anonymous:event"] .gift-name').getAttribute('data-card'), null)
  assert.equal(await page.locator('[data-id="anonymous:event"] .gift-tag').count(), 1)
  assert.equal(await page.locator('[data-id="isolated:event"] .gift-tag').count(), 0)
  assert.match(await page.locator('[data-id="isolated:event"] .gift-meta').innerText(), /3 (mois|months)/)
  assert.equal(await page.locator('[data-id="isolated:event"] .gift-card').evaluate(el => getComputedStyle(el).animationName), 'none')
  await page.locator('#chat-log').evaluate(el => { (el as HTMLElement).style.width = '300px' })
  await page.waitForFunction(() => { const log = document.querySelector('#chat-log')!; return log.scrollHeight - log.scrollTop - log.clientHeight < 3 })
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll('#chat-log .message')].map(el => el.getBoundingClientRect()).sort((a, b) => a.top - b.top)
    return rows.every((row, i) => i === 0 || row.top >= rows[i - 1].bottom - 1)
  })
  await page.locator('#chat-log').screenshot({ path: resolve(artifacts, `gifts-${locale}-narrow.png`) })
  assert.equal(await page.locator('.gift-card').evaluateAll(cards => cards.some(el => el.scrollWidth > el.clientWidth + 1)), false)
  assert.deepEqual(errors, [])
  console.log(`Gifts (${locale}): progressive grouping, bot preserved, deduplication, expansion, profiles, isolated/anonymous gifts, themes and narrow layout passed.`)
} catch (error) {
  console.error(error)
  const page = app.windows()[0]
  if (page && !page.isClosed()) console.log(await page.locator('#chat-log .message').evaluateAll(rows => rows.map(row => ({ id: (row as HTMLElement).dataset.id, top: row.getBoundingClientRect().top, height: row.getBoundingClientRect().height, measured: (row as HTMLElement).offsetHeight, transform: (row as HTMLElement).style.transform }))))
  throw error
} finally { await app.close() }
