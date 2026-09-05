import { _electron as electron } from 'playwright'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
/** Anything the window threw. Checked before the script may call itself a success. */
const rendererErrors: string[] = []

const artifacts = resolve('artifacts')
await mkdir(artifacts, { recursive: true })
const app = await electron.launch({ args: ['.'], env: { ...process.env, TWICHAT_LOCALE: process.env.TWICHAT_LOCALE ?? 'fr', TWICHAT_TEST_DATA: resolve(tmpdir(), `twichat-smoke-${process.pid}`) } })
try {
  const window = await app.firstWindow()
  window.on('pageerror', error => rendererErrors.push(error.message))
  window.on('console', message => { if (message.type() === 'error') console.error(`Console: ${message.text()}`) })
  await window.waitForLoadState('domcontentloaded')
  await window.waitForSelector('#session-gate')
  await window.waitForFunction(() => Boolean(document.body.dataset.ready))
  const ready = await window.evaluate(() => ({ state: document.body.dataset.ready, toast: document.querySelector('#toast')?.textContent }))
  if (ready.state !== 'true') throw new Error(`Renderer startup failed: ${JSON.stringify(ready)}`)
  if (await window.evaluate(() => Boolean((window as any).process))) throw new Error('Node.js is exposed to the renderer.')
  await window.screenshot({ path: resolve(artifacts, 'session-choice.png') })
  await window.locator('#connect-session').click()
  if (!await window.getByRole('button', { name: /se connecter avec twitch/i }).isVisible()) throw new Error('Twitch sign-in through the browser is missing.')
  if (!await window.getByRole('button', { name: /copier le lien/i }).isVisible()) throw new Error('Sign-in from another browser is missing.')
  if (!await window.getByText(/mot de passe reste chez twitch/i).isVisible()) throw new Error('The OAuth security explanation is missing.')
  await window.screenshot({ path: resolve(artifacts, 'account-browser-login.png') })
  await window.locator('#auth-form .dialog-footer [data-close]').click()
  await window.setViewportSize({ width: 760, height: 560 })
  const sessionCompact = await window.evaluate(() => ({ bodyWidth: document.body.scrollWidth, viewport: innerWidth, anonymousVisible: (document.querySelector('#anonymous-session') as HTMLElement).getBoundingClientRect().bottom <= innerHeight }))
  if (sessionCompact.bodyWidth > sessionCompact.viewport || !sessionCompact.anonymousVisible) throw new Error(`Compact session screen invalid: ${JSON.stringify(sessionCompact)}`)
  await window.screenshot({ path: resolve(artifacts, 'session-choice-compact.png') })
  await window.setViewportSize({ width: 1320, height: 880 })
  await window.getByRole('button', { name: /continuer en anonyme/i }).click()
  await window.waitForSelector('#app:not([hidden])')
  await window.screenshot({ path: resolve(artifacts, 'welcome.png') })
  await window.getByRole('button', { name: /explorer les chaînes/i }).click()
  await window.waitForSelector('#discover:not([hidden])')
  const locked = await window.getByText('Connectez votre compte Twitch.').isVisible()
  if (!locked) throw new Error('The catalog sign-in state is missing.')
  await window.screenshot({ path: resolve(artifacts, 'discover-locked.png') })
  await window.getByRole('button', { name: /rejoindre une chaîne/i }).click()
  await window.getByLabel('Nom de la chaîne', { exact: true }).fill('twitch')
  await window.getByRole('button', { name: 'Rejoindre', exact: true }).click()
  await window.waitForSelector('#room-view:not([hidden])')
  await window.waitForFunction(() => document.querySelector('#player-status')?.textContent !== 'À L’ARRÊT')
  await window.waitForSelector('.room-avatar img', { timeout: 15000 })

  // The shortcut labels are stamped for the platform rather than written into the markup: on a
  // Mac they must read `⌘`, and on Windows and Linux `Ctrl`, everywhere the same key is named.
  // `TWICHAT_COMMAND_KEY=ctrl` runs the Windows and Linux labels on any machine.
  const pinned = process.env.TWICHAT_COMMAND_KEY
  const expected = (pinned ? pinned === 'meta' : process.platform === 'darwin') ? '⌘ K' : 'Ctrl K'
  const printed = await window.locator('[data-keys]').allTextContents()
  if (!printed.length) throw new Error('No shortcut label was stamped into the document.')
  const join = printed.filter(text => text.endsWith('K'))
  if (!join.length || join.some(text => text !== expected)) throw new Error(`Shortcut labels read ${JSON.stringify(join)}, expected ${expected} on ${pinned ?? process.platform}.`)
  const dockBefore = await window.locator('#stream-dock').boundingBox()
  const resizer = await window.locator('#player-resizer').boundingBox()
  if (!dockBefore || !resizer) throw new Error('Resize handle missing.')
  await window.mouse.move(resizer.x + resizer.width / 2, resizer.y + resizer.height / 2)
  await window.mouse.down()
  await window.mouse.move(resizer.x - 70, resizer.y + resizer.height / 2)
  await window.mouse.up()
  const dockAfter = await window.locator('#stream-dock').boundingBox()
  if (!dockAfter || dockAfter.width < dockBefore.width + 50) throw new Error(`Video resize does nothing: ${dockBefore.width} -> ${dockAfter?.width}`)
  await window.screenshot({ path: resolve(artifacts, 'room.png') })
  const metrics = await window.evaluate(() => ({
    bodyWidth: document.body.scrollWidth, viewport: innerWidth,
    rooms: document.querySelectorAll('#rooms .room-button').length,
    title: document.querySelector('#channel-title')?.textContent,
    avatar: (document.querySelector('.room-avatar img') as HTMLImageElement | null)?.src,
    player: document.querySelector('#player-status')?.textContent,
    fullWidthChat: Math.abs((document.querySelector('.conversation') as HTMLElement).getBoundingClientRect().width - (document.querySelector('#room-body') as HTMLElement).getBoundingClientRect().width) < 2,
    floatingPlayer: getComputedStyle(document.querySelector('#stream-dock')!).position,
    resizedPlayer: Math.round((document.querySelector('#stream-dock') as HTMLElement).getBoundingClientRect().width),
    nodeIntegration: typeof (globalThis as any).require
  }))
  if (metrics.bodyWidth > metrics.viewport || metrics.rooms !== 1 || metrics.title !== 'twitch' || !metrics.avatar?.startsWith('https://static-cdn.jtvnw.net/') || metrics.player === 'À L’ARRÊT' || !metrics.fullWidthChat || metrics.floatingPlayer !== 'absolute' || metrics.nodeIntegration !== 'undefined') throw new Error(`Renderer check failed: ${JSON.stringify(metrics)}`)
  await window.locator('#add-room').click()
  await window.getByLabel('Nom de la chaîne', { exact: true }).fill('busyroom')
  await window.getByRole('button', { name: 'Rejoindre', exact: true }).click()
  await window.locator('.room-button[data-channel="twitch"]').click()
  const busyButton = await window.locator('.room-button[data-channel="busyroom"]').boundingBox()
  if (!busyButton) throw new Error('Load-test channel missing.')
  await window.mouse.move(busyButton.x + busyButton.width / 2, busyButton.y + busyButton.height / 2)
  await window.mouse.down()
  await app.evaluate(({ BrowserWindow }) => {
    const target = BrowserWindow.getAllWindows()[0]
    const now = Date.now()
    target.webContents.send('chat:events', Array.from({ length: 100 }, (_, index) => ({
      type: 'message',
      message: { id: `stress-${index}`, channel: 'busyroom', user: `viewer${index}`, login: `viewer${index}`, text: 'message rapide', color: '#b9f568', badges: [], time: now + index, action: false }
    })))
  })
  await window.waitForFunction(() => document.querySelector('.room-button[data-channel="busyroom"] .unread')?.textContent === '99+')
  await window.mouse.up()
  await window.waitForFunction(() => document.querySelector('#channel-title')?.textContent === 'busyroom')
  await window.locator('#leave-room').click()
  await window.waitForFunction(() => document.querySelector('#channel-title')?.textContent === 'twitch')
  await window.getByRole('button', { name: /explorer les chaînes/i }).click()
  await window.waitForSelector('#discover:not([hidden])')
  await window.locator('.room-button[data-channel="twitch"]').click()
  await window.waitForSelector('#room-view:not([hidden])')
  await window.waitForFunction(() => document.querySelector('#player-status')?.textContent !== 'À L’ARRÊT')
  await window.waitForTimeout(500)
  const returnTrip = await window.evaluate(() => ({
    roomVisible: !(document.querySelector('#room-view') as HTMLElement).hidden,
    discoverHidden: (document.querySelector('#discover') as HTMLElement).hidden,
    player: document.querySelector('#player-status')?.textContent,
    error: document.querySelector('#video-error')?.textContent
  }))
  if (!returnTrip.roomVisible || !returnTrip.discoverHidden || returnTrip.player === 'À L’ARRÊT' || /annulée/i.test(returnTrip.error ?? '')) throw new Error(`Back from Explore → room unstable: ${JSON.stringify(returnTrip)}`)
  await window.locator('#quality').selectOption('audio_only')
  await window.waitForSelector('#stream-dock.audio-only')
  const audioPlayer = await window.evaluate(() => ({
    stage: getComputedStyle(document.querySelector('#video-stage')!).display,
    fullscreenHidden: (document.querySelector('#fullscreen-stream') as HTMLElement).hidden,
    label: document.querySelector('#stream-dock')?.getAttribute('aria-label'),
    channel: document.querySelector('#player-channel')?.textContent,
    action: document.querySelector('#play-stream')?.getAttribute('title'),
    height: Math.round((document.querySelector('#stream-dock') as HTMLElement).getBoundingClientRect().height)
  }))
  if (audioPlayer.stage !== 'none' || !audioPlayer.fullscreenHidden || audioPlayer.label !== 'Lecteur audio de la chaîne' || !audioPlayer.channel?.startsWith('AUDIO ·') || audioPlayer.action !== 'Écouter' || audioPlayer.height > 130) throw new Error(`Audio mode not compact: ${JSON.stringify(audioPlayer)}`)
  await window.screenshot({ path: resolve(artifacts, 'audio-player.png') })
  await window.setViewportSize({ width: 760, height: 560 })
  await window.screenshot({ path: resolve(artifacts, 'compact.png') })
  const compact = await window.evaluate(() => ({ bodyWidth: document.body.scrollWidth, viewport: innerWidth, composerVisible: document.querySelector('#composer')?.getBoundingClientRect().bottom! <= innerHeight }))
  if (compact.bodyWidth > compact.viewport || !compact.composerVisible) throw new Error(`Compact check failed: ${JSON.stringify(compact)}`)
  await window.locator('.room-button[data-channel="twitch"]').click({ button: 'right' })
  await window.waitForSelector('#room-context-menu:not([hidden])')
  if (!await window.getByRole('menuitem', { name: 'Quitter la chaîne' }).isVisible()) throw new Error('The context action to leave the room is missing.')
  await window.screenshot({ path: resolve(artifacts, 'room-context-menu.png') })
  await window.getByRole('menuitem', { name: 'Quitter la chaîne' }).click()
  await window.waitForSelector('#welcome:not([hidden])')
  if (await window.locator('#rooms .room-button').count()) throw new Error('The channel left by right-click is still there.')

  // The session gate has to come back usable after a sign-out: its two fixed buttons kept
  // the disabled state set on entry, and its label the "Connexion…" it was given on entry.
  // Only the remembered-account list was rebuilt, hence the last path still clickable.
  await window.evaluate(() => { const button = document.querySelector<HTMLButtonElement>('#account-menu-logout')!; button.hidden = false; button.click() })
  await window.waitForSelector('#session-gate:not([hidden])')
  const gate = await window.evaluate(() => ({
    connect: document.querySelector<HTMLButtonElement>('#connect-session')!.disabled,
    anonymous: document.querySelector<HTMLButtonElement>('#anonymous-session')!.disabled,
    label: document.querySelector('#anonymous-session strong')?.textContent
  }))
  if (gate.connect || gate.anonymous || gate.label !== 'Continuer en anonyme') throw new Error(`The session gate comes back unusable: ${JSON.stringify(gate)}`)
  await window.getByRole('button', { name: /continuer en anonyme/i }).click()
  await window.waitForSelector('#app:not([hidden])')
  console.log(JSON.stringify(metrics))
  // An uncaught exception in the window is a failure, whatever the assertions say: printing it
  // and passing let a broken renderer look like a green run.
  if (rendererErrors.length) throw new Error(`Renderer errors: ${rendererErrors.join(' | ')}`)
} finally { await app.close() }
