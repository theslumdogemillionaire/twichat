import { _electron as electron } from 'playwright'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * Checks that a room with nothing on air leaves the picture where it is. It needs a channel that
 * is actually live — the whole point is a stream on screen surviving a visit to a quiet room, and
 * a player retrying an offline stream has no picture to keep.
 *
 * The quiet room is a name nobody broadcasts on: Twitch answers its public page for anyone, so
 * the run needs no account, and "off air" is the one thing it can be counted on to say.
 *
 * The other half — the open room taking the picture back the moment it goes live — cannot be
 * staged against a real Twitch: `heldStreamChoice` covers it in tests/stream-lifecycle.test.ts.
 */
const watched = process.argv[2] ?? 'zerator'
const quiet = 'twichat_quiet_probe'
const artifacts = resolve('artifacts')
await mkdir(artifacts, { recursive: true })
const data = resolve(tmpdir(), `twichat-kept-${process.pid}`)
const rendererErrors: string[] = []

const app = await electron.launch({ args: ['.'], env: { ...process.env, TWICHAT_LOCALE: 'fr', TWICHAT_TEST_DATA: data } })
app.process().stderr?.on('data', output => console.error(String(output)))
try {
  const window = await app.firstWindow()
  window.on('pageerror', error => rendererErrors.push(error.message))
  await window.waitForFunction(() => document.body.dataset.ready === 'true')

  const label = window.locator('#player-channel')
  const dock = () => label.textContent()
  const room = () => window.locator('#channel-title').textContent()
  const status = () => window.locator('#player-status').textContent()
  const elsewhere = async () => (await label.getAttribute('class') ?? '').includes('elsewhere')
  const join = async (name: string) => {
    await window.locator('#add-room').click()
    await window.getByLabel('Nom de la chaîne', { exact: true }).fill(name)
    await window.getByRole('button', { name: 'Rejoindre', exact: true }).click()
    await window.waitForSelector('#room-view:not([hidden])')
    // The channel just joined is the one the player takes: nothing is known of it yet, and an
    // unanswered channel starts as it always has.
    await window.waitForFunction(value => document.querySelector('#player-channel')?.textContent === `# ${value}`, name)
  }

  await window.getByRole('button', { name: /continuer en anonyme/i }).click()
  await window.waitForSelector('#app:not([hidden])')
  // The quiet room first, so the live one is the last joined: it is the picture on screen.
  await join(quiet)
  await join(watched)
  await window.waitForFunction(() => document.querySelector('#player-status')?.textContent === 'EN DIRECT', undefined, { timeout: 45000 })
  // Twitch has answered for the quiet room — the sidebar says so — so opening it is a decision
  // taken on what is known of it, not on silence.
  await window.waitForSelector(`#rooms .room-button[data-channel="${quiet}"].is-offline`, { timeout: 45000 })

  // The room off air: the picture stays on the channel it was on, and says which one that is.
  await window.locator(`#rooms .room-button[data-channel="${quiet}"]`).click()
  if (await room() !== quiet) throw new Error(`The quiet room did not open: ${await room()}`)
  if (await status() !== 'EN DIRECT') throw new Error(`Opening a quiet room cut the stream: ${await status()}`)
  if (await dock() !== `# ${watched}`) throw new Error(`The dock left the stream it was playing: ${await dock()}`)
  if (!await elsewhere()) throw new Error('The dock names another channel without saying so.')
  if (!(await label.getAttribute('title') ?? '').includes(watched)) throw new Error('The dock does not explain which channel it is on.')
  await window.screenshot({ path: resolve(artifacts, 'kept-stream.png') })

  // Back on the room the picture is on: its own stream again, named as such and never restarted.
  await window.locator(`#rooms .room-button[data-channel="${watched}"]`).click()
  if (await room() !== watched) throw new Error(`The watched room did not come back: ${await room()}`)
  if (await status() !== 'EN DIRECT') throw new Error(`Coming back restarted the stream: ${await status()}`)
  if (await dock() !== `# ${watched}`) throw new Error(`The dock lost the stream on the way back: ${await dock()}`)
  if (await elsewhere()) throw new Error('The dock still calls this room somebody else.')

  // A channel left takes its picture with it, even from a room that is not the one on screen: back
  // in the quiet room, the stream kept is the one being left.
  await window.locator(`#rooms .room-button[data-channel="${quiet}"]`).click()
  if (await dock() !== `# ${watched}`) throw new Error(`The picture did not stay a second time: ${await dock()}`)
  await window.locator(`#rooms .room-button[data-channel="${watched}"]`).click({ button: 'right' })
  await window.locator('#room-context-leave').click()
  await window.waitForFunction(() => document.querySelector('#player-status')?.textContent === 'À L’ARRÊT', undefined, { timeout: 15000 })
  if (await dock() !== `# ${quiet}`) throw new Error(`The dock kept naming the channel left behind: ${await dock()}`)
  if (await elsewhere()) throw new Error('The dock still points at a channel that is gone.')

  if (rendererErrors.length) throw new Error(`The window threw: ${rendererErrors.join(' / ')}`)
  console.log(`Kept stream smoke passed: #${watched} stayed on screen through a visit to a room off air, the dock named it, and leaving that channel took its picture away.`)
} finally {
  await app.close()
}
