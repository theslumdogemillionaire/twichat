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
  /**
   * Which of the explorer's lists is on screen. Its lists are pages of the trail: `expect` above
   * only tells the explorer from a room, and every one of them answers "discover" to that.
   */
  async function expectScope(scope: 'top' | 'followed' | 'categories' | 'category') {
    await expect('discover')
    const shown = await window.evaluate(() => {
      if (!(document.getElementById('discover-crumb') as HTMLElement).hidden) return 'category'
      for (const name of ['top', 'followed', 'categories']) {
        if (document.getElementById(`scope-${name}`)!.getAttribute('aria-pressed') === 'true') return name
      }
      return 'none'
    })
    if (shown !== scope) throw new Error(`Expected the explorer on ${scope}, got ${shown}`)
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

  // The explorer's three tabs. The third names a category being browsed and is absent until one
  // is: what is checked here is that the other two still say which of them is on screen — they
  // stopped writing that themselves when the category tab joined them — and that the language
  // follows the tab, since Twitch narrows a catalogue on it and a followed list never.
  const tabs = async () => window.evaluate(() => ({
    top: document.getElementById('scope-top')!.getAttribute('aria-pressed'),
    followed: document.getElementById('scope-followed')!.getAttribute('aria-pressed'),
    categories: document.getElementById('scope-categories')!.getAttribute('aria-pressed'),
    crumb: (document.getElementById('discover-crumb') as HTMLElement).hidden,
    tabs: (document.querySelector('.discover-scope') as HTMLElement).hidden,
    language: (document.getElementById('discover-language') as HTMLSelectElement).disabled,
    sort: (document.getElementById('discover-sort') as HTMLSelectElement).disabled
  }))
  const atStart = await tabs()
  if (atStart.top !== 'true' || atStart.followed !== 'false' || atStart.categories !== 'false' || !atStart.crumb || atStart.tabs || atStart.language || atStart.sort)
    throw new Error(`The explorer does not open on the popular channels: ${JSON.stringify(atStart)}`)
  await window.locator('#scope-followed').click()
  const onFollowed = await tabs()
  if (onFollowed.top !== 'false' || onFollowed.followed !== 'true' || !onFollowed.crumb || onFollowed.tabs || !onFollowed.language)
    throw new Error(`The followed tab does not take the press: ${JSON.stringify(onFollowed)}`)
  // A category has no language and no audience to sort by: both controls say so rather than sit
  // there doing nothing.
  await window.locator('#scope-categories').click()
  const onCategories = await tabs()
  if (onCategories.categories !== 'true' || onCategories.followed !== 'false' || !onCategories.language || !onCategories.sort)
    throw new Error(`The categories tab does not mute what does not apply to it: ${JSON.stringify(onCategories)}`)
  await window.locator('#scope-top').click()
  const back = await tabs()
  if (back.top !== 'true' || back.followed !== 'false' || back.categories !== 'false' || back.crumb === false || back.language || back.sort)
    throw new Error(`The popular tab does not take it back: ${JSON.stringify(back)}`)

  // The bottom of the list watches for itself: an element after the grid, inside the pane that
  // scrolls, collapsed while there is no page to ask for. Outside that pane the observer would
  // never fire and paging would stop silently; visible with nothing behind it, it would fire on
  // every paint.
  const sentinel = await window.evaluate(() => {
    const element = document.getElementById('discover-more') as HTMLElement | null
    const pane = document.getElementById('discover-content') as HTMLElement
    const grid = document.getElementById('discover-results') as HTMLElement
    if (!element) return null
    return {
      inPane: pane.contains(element),
      afterGrid: Boolean(grid.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING),
      display: getComputedStyle(element).display
    }
  })
  if (!sentinel) throw new Error('The explorer has no bottom to watch for.')
  if (!sentinel.inPane || !sentinel.afterGrid || sentinel.display !== 'none')
    throw new Error(`The paging sentinel is misplaced: ${JSON.stringify(sentinel)}`)

  await window.locator('#open-settings').click()
  await expect('settings')
  await expectEnds(true, false)

  // All the way back, one page at a time, then all the way forward again. The explorer's lists are
  // on that trail: each tab opened above is a step, and "back" walks them rather than leaving the
  // explorer in one jump — which is what it used to do, whichever of its lists you were looking at.
  await window.locator('#nav-back').click(); await expectScope('top')
  await window.locator('#nav-back').click(); await expectScope('categories')
  await window.locator('#nav-back').click(); await expectScope('followed')
  await window.locator('#nav-back').click(); await expectScope('top')
  await window.locator('#nav-back').click(); await expect('room', 'mistermv')
  await window.locator('#nav-back').click(); await expect('room', 'twitch')
  await expectEnds(false, true)
  await window.locator('#nav-forward').click(); await expect('room', 'mistermv')
  await window.locator('#nav-forward').click(); await expectScope('top')
  await window.locator('#nav-forward').click(); await expectScope('followed')
  await window.locator('#nav-forward').click(); await expectScope('categories')
  await window.locator('#nav-forward').click(); await expectScope('top')
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
  // Back out through the explorer's own lists before leaving it: each was a step in.
  await window.locator('#nav-back').click(); await expectScope('categories')
  await window.locator('#nav-back').click(); await expectScope('followed')
  await window.locator('#nav-back').click(); await expectScope('top')
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
  console.log('Navigation smoke passed: the trail walks, stops at its ends, forgets what is gone, the explorer tabs say which list is on screen, the bottom of the list is watched from inside the pane that scrolls, and the lists of the explorer are steps of the trail.')
} finally {
  await app.close()
}
