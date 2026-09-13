// Simulated Twitch frames go through the real IRC parser, IPC delivery and virtualized log.
// No raid is sent to Twitch, and the disposable session never uses a saved account.
import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { TwitchIrc } from '../src/main/irc'
import { setLocale } from '../src/shared/i18n'
import type { ChatEvent } from '../src/shared/types'

const locale = process.argv[2] === 'en' ? 'en' : 'fr'
setLocale(locale)
const channel = 'twichat_raid_test'
const artifacts = resolve('artifacts')
await mkdir(artifacts, { recursive: true })
const fixture = await readFile(resolve('tests/fixtures/channel-live.html'), 'utf8')
const avatar = /property="og:image" content="([^"]+)"/.exec(fixture)![1]
const errors: string[] = []
const app = await electron.launch({ args: ['.'], env: { ...process.env, TWICHAT_LOCALE: locale, TWICHAT_TEST_DATA: resolve(tmpdir(), `twichat-raid-${process.pid}`) } })
try {
  const page = await app.firstWindow()
  page.on('pageerror', error => errors.push(error.message))
  // Keep profile lookup independent of Twitch availability; the avatar itself is the CDN
  // picture recorded in the public-page fixture. Count lookups across virtual remounts.
  await app.evaluate(({ ipcMain }, avatarUrl) => {
    ipcMain.removeHandler('rooms:profiles')
    ;(globalThis as any).raidProfileCalls = []
    ipcMain.handle('rooms:profiles', async (_event, channels: string[]) => {
      ;(globalThis as any).raidProfileCalls.push(...channels)
      return channels.map(channel => ({ channel, displayName: channel === 'ponce' ? 'Ponce' : channel, avatarUrl: channel === 'ponce' ? avatarUrl : '', live: false }))
    })
  }, avatar)
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
  const raid = (id: string, extra = '', time = Date.now()) => `@msg-id=raid;id=${id};tmi-sent-ts=${time};msg-param-login=ponce;msg-param-displayName=Ponce;msg-param-viewerCount=1248${extra} :tmi.twitch.tv USERNOTICE #${channel}`
  await publish([
    `@id=hello;display-name=PixelPanda :pixelpanda!pixelpanda@pixelpanda.tmi.twitch.tv PRIVMSG #${channel} :On est prêts !`,
    raid('arrival'),
    raid('arrival'),
    `@id=welcome;display-name=Luna :luna!luna@luna.tmi.twitch.tv PRIVMSG #${channel} :Bienvenue tout le monde !`
  ])
  const card = page.locator('[data-id="arrival:event"]')
  await card.waitFor()
  assert.equal(await card.locator('.raid-name').textContent(), 'Ponce')
  assert.equal(await card.locator('.raid-arriving').count(), 1)
  const motion = await card.locator('.raid-card').evaluate(element => [
    getComputedStyle(element, '::before').animationName,
    getComputedStyle(element.querySelector('.raid-avatar')!).animationName,
    getComputedStyle(element.querySelector('.raid-crowd')!).animationName
  ])
  assert.deepEqual(motion, ['raid-stripes', 'raid-avatar-arrival', 'raid-crowd-arrival'])
  await card.locator('.raid-avatar img').waitFor()
  await page.waitForFunction(() => (document.querySelector('.raid-avatar img') as HTMLImageElement)?.naturalWidth > 0)
  assert.equal(await page.locator('[data-id="arrival:event"]').count(), 1)
  assert.equal(await page.locator('.message.system').filter({ hasText: /Ponce/ }).count(), 0)
  // Animation completion, layout measurement and pinned bottom are all observable states.
  await page.waitForFunction(() => !document.querySelector('.raid-card')?.getAnimations({ subtree: true }).some(a => a.playState === 'running'))
  await page.waitForFunction(() => {
    const log = document.querySelector('#chat-log')!
    return log.scrollHeight - log.scrollTop - log.clientHeight < 3
  })
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme }, theme)
    await page.locator('#chat-log').screenshot({ path: resolve(artifacts, `raid-${locale}-${theme}.png`) })
    await card.locator('.raid-card').screenshot({ path: resolve(artifacts, `raid-card-${locale}-${theme}.png`) })
  }
  // The source profile opens by keyboard, without taking the reader to another room.
  await card.locator('.raid-profile').focus()
  await page.keyboard.press('Enter')
  await page.waitForSelector('#user-card:not([hidden])')
  assert.match(await page.locator('#user-card').innerText(), /ponce/i)
  assert.equal(await page.locator('#user-card .user-card-name').textContent(), 'Ponce')
  assert.equal(await page.locator('#user-card .user-card-avatar img').getAttribute('src'), avatar)
  assert.equal((await page.locator('#channel-title').textContent())?.toLowerCase(), channel)
  await page.keyboard.press('Escape')

  // Force the first raid out of the virtual window, then back in; it must not celebrate again.
  await publish(Array.from({ length: 55 }, (_, i) => `@id=flood-${i};display-name=Raider :raider!raider@raider.tmi.twitch.tv PRIVMSG #${channel} :Bienvenue ${i}`))
  await card.waitFor({ state: 'detached' })
  await page.locator('#chat-log').evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new WheelEvent('wheel', { deltaY: -500 })) })
  await card.waitFor()
  assert.equal(await card.locator('.raid-arriving').count(), 0)
  const calls = await app.evaluate(() => (globalThis as any).raidProfileCalls.filter((login: string) => login === 'ponce').length)
  assert.equal(calls, 1, 'one source profile request across remounts')

  // Let the log's 500ms deliberate-scroll grace period finish before changing its geometry.
  await page.waitForTimeout(550)
  await page.locator('#resume').click()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await publish([
    raid('single', ';msg-param-viewerCount=1'),
    raid('unknown', ';msg-param-viewerCount=oops;msg-param-login=;msg-param-displayName=UneTrèsLongueCommunautéQuiDébarqueEnRaid'),
    raid('old', '', Date.now() - 60_000)
  ])
  assert.equal(await page.locator('[data-id="single:event"] .raid-crowd>span').textContent(), locale === 'fr' ? 'spectateur' : 'viewer')
  assert.equal(await page.locator('[data-id="unknown:event"] .raid-crowd').count(), 0)
  assert.equal(await page.locator('[data-id="unknown:event"] [data-card]').count(), 0)
  assert.equal(await page.locator('[data-id="old:event"] .raid-arriving').count(), 0)
  const animation = await page.locator('[data-id="single:event"] .raid-card').evaluate(element => getComputedStyle(element).animationName)
  assert.equal(animation, 'none')
  const reducedMotion = await page.locator('[data-id="single:event"] .raid-card').evaluate(element => [
    getComputedStyle(element, '::before').animationName,
    getComputedStyle(element.querySelector('.raid-avatar')!).animationName,
    getComputedStyle(element.querySelector('.raid-crowd')!).animationName
  ])
  assert.deepEqual(reducedMotion, ['none', 'none', 'none'])
  // 300px is narrower than the normal desktop room; use the real row and its container query.
  await page.locator('#chat-log').evaluate(element => { (element as HTMLElement).style.width = '300px' })
  await page.waitForFunction(() => {
    const log = document.querySelector('#chat-log')!
    return log.scrollHeight - log.scrollTop - log.clientHeight < 3
  })
  await page.locator('#chat-log').screenshot({ path: resolve(artifacts, `raid-${locale}-narrow.png`) })
  const overflow = await page.locator('.raid-card').evaluateAll(cards => cards.filter(card => card.scrollWidth > card.clientWidth + 1).map(card => ({
    width: card.clientWidth, scroll: card.scrollWidth, text: card.textContent,
    children: [...card.querySelectorAll('*')].filter(child => child.getBoundingClientRect().right > card.getBoundingClientRect().right).map(child => ({ class: child.getAttribute('class'), width: child.getBoundingClientRect().width }))
  })))
  assert.deepEqual(overflow, [], 'long names and counts fit a narrow chat')
  assert.deepEqual(errors, [])
  console.log(`Raid UI (${locale}): avatar, profile, deduplication, scroll, single arrival, reduced motion, themes and narrow layout passed.`)
} catch (error) {
  const page = await app.firstWindow()
  console.log(await page.locator('#chat-log').evaluate(element => ({ scroll: element.scrollTop, height: element.scrollHeight, client: element.clientHeight, resume: (document.querySelector('#resume') as HTMLElement).hidden, cards: [...element.querySelectorAll('.raid-card')].map(card => ({ text: card.textContent, width: card.clientWidth, scroll: card.scrollWidth, children: [...card.querySelectorAll('*')].filter(child => child.getBoundingClientRect().right > card.getBoundingClientRect().right).map(child => ({ class: child.getAttribute('class'), width: child.getBoundingClientRect().width })) })) })))
  throw error
} finally { await app.close() }
