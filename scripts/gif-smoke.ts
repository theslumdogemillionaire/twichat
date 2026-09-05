// The GIFs of Twitch's GIPHY keyboard, rendered by the real window. A GIF only ever comes from
// a Tier 2 subscriber of the room, which no test can arrange, so the message is pushed through
// the very channel the IRC client publishes on and the window is left to do the rest.
import { _electron as electron } from 'playwright'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import type { ChatMessage } from '../src/shared/types'

// The address of the example in the Twitch documentation, used whole as its `gifs` tag gives it.
const GIF_URL = 'https://media4.giphy.com/media/joSNxeswxuc74Juo8X/giphy.gif?cid=095d7a5d&ep=v1_gifs_trending&rid=giphy.gif&ct=g'
const channel = process.argv[2] ?? 'twitch'
const artifacts = resolve('artifacts')
await mkdir(artifacts, { recursive: true })
/** Anything the window threw. Checked before the script may call itself a success. */
const rendererErrors: string[] = []

const message = (id: string, login: string, user: string, text: string, extra: Partial<ChatMessage> = {}) => ({
  type: 'message' as const,
  message: { id, channel, login, user, text, color: '', badges: [], time: Date.now(), action: false, ...extra } satisfies ChatMessage
})

const app = await electron.launch({ args: ['.'], env: { ...process.env, TWICHAT_LOCALE: 'fr', TWICHAT_TEST_DATA: resolve(tmpdir(), `twichat-gif-${process.pid}`) } })
try {
  const page = await app.firstWindow()
  page.on('pageerror', error => rendererErrors.push(error.message))
  await page.waitForFunction(() => document.body.dataset.ready === 'true')
  await page.getByRole('button', { name: /continuer en anonyme/i }).click()
  await page.waitForSelector('#app:not([hidden])')
  await page.getByRole('button', { name: /rejoindre ma première chaîne/i }).click()
  await page.getByLabel('Nom de la chaîne', { exact: true }).fill(channel)
  await page.getByRole('button', { name: 'Rejoindre', exact: true }).click()
  await page.waitForSelector('#room-view:not([hidden])')

  await app.evaluate(({ BrowserWindow }, events) => {
    const [window] = BrowserWindow.getAllWindows()
    window?.webContents.send('chat:events', events)
  }, [
    // A GIF alone in its message: the whole body is the title Twitch wrote for it.
    message('401abf17-7e99-45d6-9bdf-43934e839327', 'twitchdev', 'TwitchDev', '[Y A Y Yes GIF by Djemilah Birnie]', { gifs: `0-33|joSNxeswxuc74Juo8X|${GIF_URL}` }),
    // A GIF among words, a link and an emote: each keeps its own place in the line.
    message('401abf17-7e99-45d6-9bdf-43934e839328', 'pixelpanda', 'pixelpanda', 'regarde [Yes GIF] et https://twitch.tv Kappa', { emotes: '25:39-43', gifs: `8-16|joSNxeswxuc74Juo8X|${GIF_URL}` }),
    // An address that is not GIPHY's: nothing is fetched, and the title stays as text.
    message('401abf17-7e99-45d6-9bdf-43934e839329', 'mallory', 'mallory', '[Faux GIF]', { gifs: '0-9|abc|https://cdn.example.com/a.gif' })
  ])

  await page.waitForSelector('.message-gif', { timeout: 15000 })
  // A GIF that loaded has natural dimensions; one the CSP or the host refused has none.
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('.message-gif')].every(image => image.naturalWidth > 0), undefined, { timeout: 15000 })
  const seen = await page.evaluate(() => ({
    gifs: [...document.querySelectorAll<HTMLImageElement>('.message-gif')].map(image => ({ src: image.src, alt: image.alt, height: image.getBoundingClientRect().height })),
    texts: [...document.querySelectorAll('.message-text')].map(node => node.textContent)
  }))
  await page.locator('#chat-log').screenshot({ path: resolve(artifacts, 'gif-chat.png') })

  if (seen.gifs.length !== 2) throw new Error(`Two GIFs were sent, ${seen.gifs.length} rendered: ${JSON.stringify(seen.gifs)}`)
  if (seen.gifs.some(gif => gif.src !== GIF_URL)) throw new Error(`The address was rewritten: ${JSON.stringify(seen.gifs.map(gif => gif.src))}`)
  if (seen.gifs.some(gif => gif.height > 160)) throw new Error(`A GIF grows past its bound: ${JSON.stringify(seen.gifs.map(gif => gif.height))}`)
  if (!seen.texts.some(text => text?.includes('[Faux GIF]'))) throw new Error('The GIF from another host lost its title instead of staying text')

  // Turned off in the settings, the images give way to the titles Twitch wrote.
  await page.locator('#open-settings').click()
  await page.waitForSelector('#settings:not([hidden])')
  await page.locator('#chat-gifs').uncheck()
  await page.locator(`.room-button[data-channel="${channel}"]`).click()
  await page.waitForSelector('#room-view:not([hidden])')
  await page.waitForFunction(() => !document.querySelector('.message-gif'), undefined, { timeout: 5000 })
  const withoutGifs = await page.evaluate(() => [...document.querySelectorAll('.message-text')].map(node => node.textContent))
  if (!withoutGifs.some(text => text?.includes('[Y A Y Yes GIF by Djemilah Birnie]'))) {
    throw new Error(`The title does not take the image's place: ${JSON.stringify(withoutGifs)}`)
  }

  if (rendererErrors.length) throw new Error(`The window threw: ${rendererErrors.join(' | ')}`)
  console.log(`GIFs rendered and turned off again on #${channel}: ${JSON.stringify(seen.gifs.map(gif => gif.alt))}`)
} finally { await app.close() }
