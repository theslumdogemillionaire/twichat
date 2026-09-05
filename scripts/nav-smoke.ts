import { _electron as electron } from 'playwright'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * Checks the back and forward buttons in the title bar: that they walk the pages actually
 * visited — rooms, the explorer, the settings — that they stop at both ends rather than going
 * quietly nowhere, and that a channel left takes its pages with it.
 *
 * Anonymous throughout: joining a channel and opening the explorer need no account, and what is
 * under test is the trail, not what Twitch answers.
 */
const data = resolve(tmpdir(), `twichat-nav-${process.pid}`)
const rendererErrors: string[] = []

/** The page on screen, named the way the trail names it. */
type Page = 'welcome' | 'room' | 'discover' | 'settings'

const app = await electron.launch({
  args: ['.'],
  // The command key is pinned so the shortcut below is the same chord on every platform.
  env: { ...process.env, TWICHAT_LOCALE: 'fr', TWICHAT_COMMAND_KEY: 'meta', TWICHAT_TEST_DATA: data }
})
try {
  const window = await app.firstWindow()
  window.on('pageerror', error => rendererErrors.push(error.message))
  await window.waitForFunction(() => document.body.dataset.ready === 'true')

  const page = () => window.locator('#main').getAttribute('data-view') as Promise<Page>
  const channel = () => window.locator('#channel-title').textContent()
  const disabled = (button: 'back' | 'forward') => window.locator(`#nav-${button}`).isDisabled()

  async function expect(view: Page, room?: string) {
    await window.waitForSelector(`#main[data-view="${view}"]`)
    const [shown, open] = [await page(), await channel()]
    if (shown !== view) throw new Error(`Expected the ${view} page, got ${shown}`)
    if (room !== undefined && open !== room) throw new Error(`Expected the room ${room}, got ${open}`)
  }
  async function expectEnds(back: boolean, forward: boolean) {
    if (await disabled('back') !== !back) throw new Error(`"Back" should be ${back ? 'available' : 'a dead end'}`)
    if (await disabled('forward') !== !forward) throw new Error(`"Forward" should be ${forward ? 'available' : 'a dead end'}`)
  }
  const join = async (name: string) => {
    await window.getByRole('button', { name: /rejoindre une chaîne/i }).click()
    await window.getByLabel('Nom de la chaîne', { exact: true }).fill(name)
    await window.getByRole('button', { name: 'Rejoindre', exact: true }).click()
    await window.waitForSelector('#room-view:not([hidden])')
  }

  await window.getByRole('button', { name: /continuer en anonyme/i }).click()
  await window.waitForSelector('#app:not([hidden])')
  // The welcome page is not a destination: it is where there is nothing to go back to yet.
  await expect('welcome')
  await expectEnds(false, false)

  await join('twitch')
  await expect('room', 'twitch')
  // The first page is the root of the trail, not a step taken from the welcome page.
  await expectEnds(false, false)

  await join('mistermv')
  await expect('room', 'mistermv')
  await expectEnds(true, false)

  await window.locator('#open-discover').click()
  await expect('discover')
  await window.locator('#open-settings').click()
  await expect('settings')
  await expectEnds(true, false)

  // All the way back, one page at a time, then all the way forward again.
  await window.locator('#nav-back').click(); await expect('discover')
  await window.locator('#nav-back').click(); await expect('room', 'mistermv')
  await window.locator('#nav-back').click(); await expect('room', 'twitch')
  await expectEnds(false, true)
  await window.locator('#nav-forward').click(); await expect('room', 'mistermv')
  await window.locator('#nav-forward').click(); await expect('discover')
  await window.locator('#nav-forward').click(); await expect('settings')
  await expectEnds(true, false)

  // The keyboard walks the same trail as the buttons.
  await window.keyboard.press('Meta+ArrowLeft')
  await expect('discover')
  await window.keyboard.press('Meta+ArrowRight')
  await expect('settings')

  // Alt and an arrow: the same trail again, on the chord Windows and Linux keyboards use.
  await window.keyboard.press('Alt+ArrowLeft')
  await expect('discover')
  await window.keyboard.press('Alt+ArrowRight')
  await expect('settings')

  // The mouse's side buttons. Playwright's own mouse knows only the three ordinary ones, so the
  // press goes in through the debugging protocol — a real input event either way, delivered the
  // way Chromium delivers a click. Aimed away from the title bar, the window's drag handle.
  const cdp = await app.context().newCDPSession(window)
  async function sideButton(button: 'back' | 'forward') {
    const shared = { x: 660, y: 400, button, clickCount: 1 }
    await cdp.send('Input.dispatchMouseEvent', { ...shared, type: 'mousePressed', buttons: button === 'back' ? 8 : 16 })
    await cdp.send('Input.dispatchMouseEvent', { ...shared, type: 'mouseReleased', buttons: 0 })
  }
  await sideButton('back')
  await expect('discover')
  await sideButton('forward')
  await expect('settings')

  // The same two, as the window reports them where the system claims them first: Windows and
  // Linux hand them to the application rather than to the page, and none of that runs on a Mac.
  const command = (name: string) => app.evaluate(({ BrowserWindow }, sent) => {
    BrowserWindow.getAllWindows()[0]!.emit('app-command', { preventDefault() {} }, sent)
  }, name)
  await command('browser-backward')
  await expect('discover')
  await command('browser-forward')
  await expect('settings')

  // A field keeps the chord: in the explorer's search box it moves the caret, and the page
  // stays put. The composer would say the same, but it is disabled without an account.
  await window.locator('#nav-back').click(); await expect('discover')
  await window.locator('#discover-query').fill('zerator')
  await window.locator('#discover-query').click()
  await window.keyboard.press('Meta+ArrowLeft')
  await expect('discover')
  await window.locator('#discover-query').fill('')
  await window.locator('#nav-back').click(); await expect('room', 'mistermv')

  // Going somewhere new from the middle of the trail drops what "forward" held.
  await window.locator('#open-settings').click()
  await expect('settings')
  await expectEnds(true, false)

  // A channel left from the sidebar, while another page is on screen: nothing moves under the
  // reader, and the trail simply stops leading to a room that is gone.
  await window.locator('#rooms .room-button', { hasText: 'Twitch' }).click({ button: 'right' })
  await window.locator('#room-context-leave').click()
  await expect('settings')
  await window.locator('#nav-back').click(); await expect('room', 'mistermv')
  await expectEnds(false, true)

  // The last channel closed brings the welcome page back. It is a starting point rather than a
  // page: it clears the trail instead of joining it, since the video dock it has no room for
  // would otherwise keep sounding behind it.
  await window.locator('#leave-room').click()
  await expect('welcome')
  await expectEnds(false, false)

  if (rendererErrors.length) throw new Error(`The window threw: ${rendererErrors.join(' / ')}`)
  console.log('Navigation smoke passed: the trail walks, stops at its ends and forgets what is gone.')
} finally {
  await app.close()
}
