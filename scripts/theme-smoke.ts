import { _electron as electron } from 'playwright'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
/** Anything the window threw. Checked before the script may call itself a success. */
const rendererErrors: string[] = []

const artifacts = resolve('artifacts')
await mkdir(artifacts, { recursive: true })
const app = await electron.launch({ args: ['.'], env: { ...process.env, TWICHAT_LOCALE: process.env.TWICHAT_LOCALE ?? 'fr', TWICHAT_TEST_DATA: resolve(tmpdir(), `twichat-theme-${process.pid}`) } })
try {
  const window = await app.firstWindow()
  window.on('pageerror', error => rendererErrors.push(error.message))
  window.on('console', message => { if (message.type() === 'error') console.error(`Console: ${message.text()}`) })
  await window.waitForLoadState('domcontentloaded')
  await window.waitForFunction(() => Boolean(document.body.dataset.ready))
  await window.setViewportSize({ width: 1320, height: 880 })
  await window.getByRole('button', { name: /continuer en anonyme/i }).click()
  await window.waitForSelector('#app:not([hidden])')

  // The two icons on the account row have to stay aligned and share the same tint.
  const rowIcons = await window.evaluate(() => ['#open-settings svg', '.account>span:last-child svg'].map(selector => {
    const element = document.querySelector(selector)!
    const rect = element.getBoundingClientRect()
    return `${(rect.y + rect.height / 2).toFixed(1)}|${rect.width}|${getComputedStyle(element).color}`
  }))
  if (rowIcons[0] !== rowIcons[1]) throw new Error(`Gear and account chevron out of step: ${rowIcons.join(' vs ')}`)
  // Collapsed, the sidebar has no room left for the gear: the account menu must then carry the settings.
  const rail = await window.evaluate(() => {
    document.querySelector('#app')!.classList.add('sidebar-collapsed')
    const gear = document.querySelector('#open-settings')!
    const hidden = getComputedStyle(gear).display === 'none'
    document.querySelector('#app')!.classList.remove('sidebar-collapsed')
    return hidden
  })
  if (!rail) throw new Error('The gear stays in the collapsed sidebar.')

  // Open through the menu, not the button: it is the ⌘, shortcut path that needs checking.
  const accelerator = await app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()?.items.flatMap(entry => entry.submenu?.items ?? []).find(entry => entry.label === 'Réglages…')
    item?.click()
    return item?.accelerator
  })
  if (accelerator !== 'CmdOrCtrl+,') throw new Error(`The settings shortcut is missing: ${accelerator}`)
  await window.waitForSelector('#settings:not([hidden])')
  if (!await window.locator('#welcome').isHidden()) throw new Error('Settings opened on top of the welcome screen.')
  const surfaces = () => window.evaluate(() => ({
    theme: document.documentElement.dataset.theme ?? 'system',
    scheme: getComputedStyle(document.documentElement).colorScheme,
    app: getComputedStyle(document.querySelector('#app')!).backgroundColor,
    sidebar: getComputedStyle(document.querySelector('.sidebar')!).backgroundColor,
    text: getComputedStyle(document.querySelector('#app')!).color,
    logo: getComputedStyle(document.querySelector('.brand-logo')!).content,
    // The video stage is a deliberately dark island: background, text and accent must all stay dark.
    stage: getComputedStyle(document.querySelector('.video-stage')!).backgroundColor,
    stageText: getComputedStyle(document.querySelector('.video-placeholder p')!).color,
    stageTitle: getComputedStyle(document.querySelector('.video-placeholder strong')!).color,
    stageAccent: getComputedStyle(document.querySelector('.play-outline')!).color,
  }))

  // The three choices on the settings page drive the theme, and the setting left in place is "system".
  const seen: Record<string, Awaited<ReturnType<typeof surfaces>>> = {}
  for (const choice of ['light', 'dark', 'system']) {
    await window.locator(`input[name=theme][value=${choice}]`).check()
    await window.waitForTimeout(120)
    const state = await surfaces()
    if (state.theme !== choice) throw new Error(`Choice "${choice}" gave "${state.theme}".`)
    seen[choice] = state
  }
  const stored = await window.evaluate(() => document.querySelector<HTMLInputElement>('input[name=theme]:checked')?.value)
  if (stored !== 'system') throw new Error(`The checked choice does not follow the applied theme: ${stored}`)
  const channel = (color: string) => Number(color.match(/\d+/)?.[0] ?? NaN)
  if (!(channel(seen.light.app) > 200)) throw new Error(`The light background stays dark: ${seen.light.app}`)
  if (!(channel(seen.dark.app) < 60)) throw new Error(`The dark background lightened up: ${seen.dark.app}`)
  if (!(channel(seen.light.text) < 80)) throw new Error(`Light theme text stays light: ${seen.light.text}`)
  if (seen.light.scheme !== 'light' || seen.dark.scheme !== 'dark') throw new Error(`color-scheme out of step: ${JSON.stringify(seen)}`)
  if (seen.light.app === seen.light.sidebar) throw new Error('The light theme flattened the sidebar into the background.')
  if (!seen.light.logo.includes('twichat-logo-light')) throw new Error(`The logo did not switch on a light background: ${seen.light.logo}`)
  if (seen.dark.logo.includes('twichat-logo-light')) throw new Error(`The light logo spills into the dark theme: ${seen.dark.logo}`)
  for (const part of ['stage', 'stageText', 'stageTitle', 'stageAccent'] as const) {
    if (seen.light[part] !== seen.dark[part]) throw new Error(`The video stage followed the theme (${part}): ${seen.light[part]} / ${seen.dark[part]}`)
  }

  const paint = async (theme: 'dark' | 'light') => {
    await window.evaluate(value => { document.documentElement.dataset.theme = value }, theme)
    await window.waitForTimeout(120)
  }
  const themes = ['dark', 'light'] as const
  for (const theme of themes) {
    await paint(theme)
    await window.screenshot({ path: resolve(artifacts, `theme-settings-${theme}.png`) })
  }
  // The account opens its menu, and it is that menu which leads to the sign-in dialog.
  await window.locator('#account-button').click()
  await window.waitForSelector('#account-menu:not([hidden])')
  for (const theme of themes) {
    await paint(theme)
    await window.screenshot({ path: resolve(artifacts, `theme-account-menu-${theme}.png`) })
  }
  await window.locator('#account-menu-connect').click()
  await window.waitForTimeout(200)
  for (const theme of themes) {
    await paint(theme)
    await window.screenshot({ path: resolve(artifacts, `theme-dialog-${theme}.png`) })
  }
  await window.locator('#auth-form .dialog-footer [data-close]').click()
  await window.getByRole('button', { name: /rejoindre une chaîne/i }).click()
  await window.getByLabel('Nom de la chaîne', { exact: true }).fill('twitch')
  await window.getByRole('button', { name: 'Rejoindre', exact: true }).click()
  await window.waitForSelector('#room-view:not([hidden])')
  await window.waitForSelector('.room-avatar img', { timeout: 15000 })
  for (const theme of themes) {
    await paint(theme)
    await window.screenshot({ path: resolve(artifacts, `theme-room-${theme}.png`) })
  }
  console.log('Light and dark themes verified.')
  // An uncaught exception in the window is a failure, whatever the assertions say: printing it
  // and passing let a broken renderer look like a green run.
  if (rendererErrors.length) throw new Error(`Renderer errors: ${rendererErrors.join(' | ')}`)
} finally {
  await app.close()
}
