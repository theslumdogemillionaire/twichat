import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { _electron as electron } from 'playwright'
import type { Snapshot } from '../src/shared/types'

// Exercise the real renderer with deterministic IPC data, without signing in or joining chats.
const artifacts = resolve('artifacts')
await mkdir(artifacts, { recursive: true })
const app = await electron.launch({ args: ['.'], env: { ...process.env, TWICHAT_LOCALE: 'fr', TWICHAT_TEST_DATA: resolve(tmpdir(), `twichat-sidebar-${process.pid}`) } })
const errors: string[] = []
try {
  const page = await app.firstWindow()
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForFunction(() => document.body.dataset.ready === 'true')
  const snapshot = await page.evaluate(() => (window as any).twichat.init()) as Snapshot
  const awake = Array.from({ length: 16 }, (_, i) => `channel_${i + 1}`)
  const idle = Array.from({ length: 18 }, (_, i) => `quiet_${i + 1}`)
  snapshot.account = 'sidebar_owner'
  snapshot.preferences.channels = [...awake, ...idle]
  snapshot.preferences.active = ''
  snapshot.preferences.theme = 'dark'
  snapshot.preferences.playback.autoplay = false
  snapshot.preferences.layout.sidebarCollapsed = true
  snapshot.preferences.layout.hideIdleChannels = true
  // Every handler is replaced inline rather than through a helper declared here. Playwright sends
  // this function over as source, and a named function expression inside it is transpiled to a
  // `__name(...)` call whose helper exists only in this file's module scope: the other side throws
  // `__name is not defined` before the first handler is registered. The rest of the smokes take
  // the same precaution — see `raid-smoke.ts`, where the helpers stay outside the callback.
  await app.evaluate(({ ipcMain }, { snapshot, awake, idle }) => {
    ipcMain.removeHandler('app:init'); ipcMain.handle('app:init', () => snapshot)
    ipcMain.removeHandler('rooms:profiles')
    ipcMain.handle('rooms:profiles', (_event, channels: string[]) => channels.map(channel => ({ channel, displayName: channel, avatarUrl: '', live: awake.includes(channel), viewers: 1200 })))
    ipcMain.removeHandler('rooms:activity')
    ipcMain.handle('rooms:activity', () => Object.fromEntries([...awake.map(name => [name, Date.now()]), ...idle.map(name => [name, 1])]))
    for (const name of ['preferences:save', 'rooms:mark-activity', 'chat:join']) { ipcMain.removeHandler(name); ipcMain.handle(name, () => undefined) }
  }, { snapshot, awake, idle })
  await page.reload()
  await page.waitForSelector('#app.sidebar-collapsed:not([hidden]):not(.session-enter)')
  await page.waitForFunction(() => document.querySelector('#idle-count')?.textContent === '18')
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('chat:events', [1, 53, 120].flatMap((count, i) => Array.from({ length: count }, (_, n) => ({ type: 'message', message: {
      id: `sidebar-${i}-${n}`, channel: `channel_${i + 1}`, user: 'Viewer', login: 'viewer', text: 'Hello', color: '', badges: [], time: Date.now(), action: false
    } }))))
  })
  await page.waitForFunction(() => document.querySelector('[data-channel="channel_3"] .unread')?.textContent === '99+')

  for (const height of [880, 560]) {
    await page.setViewportSize({ width: 1100, height })
    await page.locator('#channel-scroll').evaluate(element => { element.scrollTop = 0 })
    const layout = await page.evaluate(() => {
      // Measured up front into a map, for the reason given above the first `evaluate`: a helper
      // named here would reach the page as a `__name(...)` call with no helper behind it. Reading a
      // rectangle moves nothing, so taking all of them at once measures the same layout the
      // lazy calls did — and `?.` keeps the toggle optional, as its own guard below still expects.
      const rects = new Map(['#open-discover', '#add-room', '#own-channel .room-avatar', '#rooms .room-avatar', '#account-avatar', '#toggle-sidebar', '.brand', '.sidebar-bottom', '#sidebar']
        .map(selector => [selector, document.querySelector(selector)?.getBoundingClientRect()] as [string, DOMRect | undefined]))
      return {
        controls: ['#open-discover', '#add-room'].map(selector => ({ width: rects.get(selector)!.width, height: rects.get(selector)!.height })),
        centers: ['#own-channel .room-avatar', '#rooms .room-avatar', '#account-avatar'].map(selector => rects.get(selector)!.x + rects.get(selector)!.width / 2),
        scrollOwners: [...document.querySelectorAll<HTMLElement>('#sidebar *')].filter(el => el.scrollHeight > el.clientHeight && ['auto', 'scroll'].includes(getComputedStyle(el).overflowY)).map(el => el.id),
        toggleBelowBrand: Boolean(document.querySelector('.sidebar-rail-controls #toggle-sidebar')) && rects.get('#toggle-sidebar')!.top >= rects.get('.brand')!.bottom && rects.get('#toggle-sidebar')!.bottom <= rects.get('#open-discover')!.top,
        bottom: rects.get('.sidebar-bottom')!.bottom,
        sidebarBottom: rects.get('#sidebar')!.bottom
      }
    })
    assert.deepEqual(layout.controls, [{ width: 40, height: 40 }, { width: 40, height: 40 }])
    assert.ok(Math.max(...layout.centers) - Math.min(...layout.centers) < 1, JSON.stringify(layout))
    assert.deepEqual(layout.scrollOwners, ['channel-scroll'])
    assert.ok(layout.toggleBelowBrand)
    assert.ok(Math.abs(layout.bottom - layout.sidebarBottom) < 1)
    assert.ok(await page.locator('#rooms .unread:not([hidden])').evaluateAll(badges => badges.every(badge => {
      const b = badge.getBoundingClientRect(), row = badge.parentElement!.getBoundingClientRect()
      return b.top >= row.top && b.bottom <= row.bottom && b.left >= row.left && b.right <= row.right
    })))

    // The fold opens in the same scroll flow, and every dormant channel remains reachable.
    await page.locator('#idle-toggle').click()
    assert.equal(await page.locator('#idle-toggle').getAttribute('aria-expanded'), 'true')
    await page.locator('#idle-rooms .room-button').last().focus()
    assert.ok(await page.locator('#channel-scroll').evaluate(el => el.scrollTop > 0))
    assert.equal(await page.locator('#idle-rooms').evaluate(el => getComputedStyle(el).overflowY), 'visible')
    await page.locator('#sidebar').screenshot({ path: resolve(artifacts, `sidebar-${height}-idle.png`) })
    await page.locator('#idle-toggle').click()
    await page.locator('#channel-scroll').evaluate(el => { el.scrollTop = 0 })
    await page.mouse.move(400, 200)
    await page.locator('#sidebar').screenshot({ path: resolve(artifacts, `sidebar-${height}.png`) })
  }

  // Pointer and keyboard both name icon-only actions, and scrolling dismisses room previews.
  await page.locator('#open-discover').hover()
  await page.waitForSelector('#rail-tip:not([hidden])')
  assert.match(await page.locator('#rail-tip').innerText(), /[Ee]xplorer/)
  await page.locator('#add-room').focus()
  assert.match(await page.locator('#rail-tip').innerText(), /[Rr]ejoindre/)
  await page.locator('#rooms .room-button').first().hover()
  await page.waitForSelector('#rail-tip:not([hidden])')
  await page.mouse.wheel(0, 200)
  await page.waitForSelector('#rail-tip[hidden]', { state: 'attached' })

  await page.locator('#toggle-sidebar').click()
  assert.equal(await page.locator('#toggle-sidebar').evaluate(el => el === document.activeElement), true)
  assert.equal(await page.locator('.rooms-heading #toggle-sidebar').count(), 1)
  await page.locator('#idle-toggle').click()
  await page.locator('#sidebar').screenshot({ path: resolve(artifacts, 'sidebar-expanded.png') })
  await page.locator('#toggle-sidebar').click()
  await page.locator('#open-discover').click()
  await page.waitForSelector('#discover:not([hidden])')
  await page.locator('#add-room').click()
  await page.waitForSelector('#join-dialog[open]')
  await page.keyboard.press('Escape')
  await page.locator('#rooms .room-button').first().click()
  await page.waitForSelector('#room-view:not([hidden])')
  assert.equal(await page.locator('#rooms .room-button').first().getAttribute('aria-current'), 'true')
  await page.mouse.move(400, 200)
  await page.locator('#sidebar').screenshot({ path: resolve(artifacts, 'sidebar-selected.png') })

  // The empty anonymous rail and the light palette must also keep their fixed commands.
  snapshot.account = null
  snapshot.preferences.channels = []
  snapshot.preferences.theme = 'light'
  await app.evaluate(({ ipcMain }, empty) => {
    ipcMain.removeHandler('app:init'); ipcMain.handle('app:init', () => empty)
    ipcMain.removeHandler('session:anonymous'); ipcMain.handle('session:anonymous', () => undefined)
  }, snapshot)
  await page.reload()
  await page.waitForFunction(() => document.body.dataset.ready === 'true')
  await page.getByRole('button', { name: /continuer en anonyme/i }).click()
  await page.waitForSelector('#app:not([hidden]):not(.session-enter)')
  assert.equal(await page.locator('#own-channel-block').isVisible(), false)
  assert.equal(await page.locator('#open-discover').evaluate(el => el.getBoundingClientRect().height), 40)
  await page.locator('#sidebar').screenshot({ path: resolve(artifacts, 'sidebar-empty-light.png') })
  assert.deepEqual(errors, [])
  console.log('Sidebar: fixed controls and aligned avatars at 880/560 px, one scroll owner, dormant channels reachable by keyboard, tooltips, toggle focus and actions passed.')
} finally { await app.close() }
