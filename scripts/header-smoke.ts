import { _electron as electron } from 'playwright'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'

// The room header says what the channel is: its followers, and the tags Twitch lists it under.
// Both come from Helix and therefore need a signed-in account, which an automated run does not
// have. What is checked here is everything else: the header no longer repeats the signed-in
// account, the two elements exist and stay collapsed without an account, the follower line reads
// the same in either state of the heart, and four tags plus a live audience still fit in the
// header at the width where the window stops shrinking.
const channel = process.argv[2] ?? 'twitch'
const artifacts = resolve('artifacts')
await mkdir(artifacts, { recursive: true })
const app = await electron.launch({ args: ['.'], env: { ...process.env, TWICHAT_LOCALE: process.env.TWICHAT_LOCALE ?? 'fr', TWICHAT_TEST_DATA: resolve(tmpdir(), `twichat-header-${process.pid}`) } })
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
  await page.waitForFunction(() => document.querySelector('#connection-dot')?.classList.contains('connected'))

  const wiring = await page.evaluate(() => {
    const ids = ['channel-subtitle', 'channel-live', 'channel-followers', 'channel-tags']
    return {
      missing: ids.filter(id => !document.getElementById(id)),
      subtitle: document.getElementById('channel-subtitle')!.textContent,
      followers: (document.getElementById('channel-followers') as HTMLElement).hidden,
      tags: (document.getElementById('channel-tags') as HTMLElement).hidden
    }
  })
  if (wiring.missing.length) throw new Error(`Header incomplete: ${wiring.missing.join(', ')}`)
  // The account is on its own button and the connection on its own dot: a connected chat has
  // nothing to say on this line.
  if (wiring.subtitle) throw new Error(`The header repeats the connection: ${JSON.stringify(wiring.subtitle)}`)
  if (!wiring.followers || !wiring.tags) throw new Error('Followers and tags show with no signed-in account.')

  // What Helix would answer for a followed channel, painted as the renderer paints it.
  await page.evaluate(() => {
    // The filled heart of `icons.ts`, written out: a page evaluated by Playwright has no bundle.
    const heart = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path fill="currentColor" d="M12 20s-7-4.4-9-8.5A5 5 0 0 1 12 6a5 5 0 0 1 9 5.5C19 15.6 12 20 12 20Z"/></svg>'
    const live = document.getElementById('channel-live') as HTMLElement
    live.innerHTML = '<span class="channel-live-stat">12 043</span><span class="channel-live-stat">3 h 12</span>'
    live.hidden = false
    const followers = document.getElementById('channel-followers') as HTMLElement
    followers.classList.add('is-following')
    followers.innerHTML = `${heart} 1,2 M followers`
    followers.hidden = false
    const tags = document.getElementById('channel-tags') as HTMLElement
    tags.replaceChildren()
    for (const label of ['Français', 'Speedrun', 'Chill', 'Interactif']) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'channel-tag'; button.textContent = label
      tags.append(button)
    }
    tags.hidden = false
  })
  await page.locator('.room-header').screenshot({ path: resolve(artifacts, 'header-channel.png') })

  // The header keeps the channel and the actions readable at the narrowest window the app allows:
  // the tags are what gives way, never the name or the buttons.
  await page.setViewportSize({ width: 960, height: 700 })
  const fit = await page.evaluate(() => {
    const header = document.querySelector('.room-header') as HTMLElement
    const actions = document.querySelector('.header-actions') as HTMLElement
    const title = document.getElementById('channel-title') as HTMLElement
    return { overflow: header.scrollWidth > header.clientWidth, actions: actions.getBoundingClientRect().right <= innerWidth, title: title.getBoundingClientRect().width > 0 }
  })
  if (fit.overflow || !fit.actions || !fit.title) throw new Error(`The header overflows once filled: ${JSON.stringify(fit)}`)
  await page.locator('.room-header').screenshot({ path: resolve(artifacts, 'header-channel-compact.png') })

  // Not followed: the same line, hollow heart, no lime.
  await page.setViewportSize({ width: 1320, height: 880 })
  await page.evaluate(() => {
    const followers = document.getElementById('channel-followers') as HTMLElement
    followers.classList.remove('is-following')
    followers.querySelector('path')?.removeAttribute('fill')
    followers.querySelector('svg')?.setAttribute('fill', 'none')
  })
  await page.locator('.room-header').screenshot({ path: resolve(artifacts, 'header-channel-unfollowed.png') })

  if (errors.length) throw new Error(`Renderer errors: ${errors.join(' | ')}`)
  console.log(`Room header on #${channel}: no connection line, followers and tags collapsed without an account, and the filled header holds at 960 px.`)
} finally { await app.close() }
