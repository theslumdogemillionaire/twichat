/**
 * Checks that the logo copies still match their master.
 *
 * The same 512×512 PNG lives in three places — the packaged app icon, the renderer, the site —
 * because each is read by a different build, and a binary duplicated by hand drifts in silence.
 * There is no vector source in the repository: these PNGs are the master. `icon.icns` and
 * `icon.ico` are not committed either; electron-builder derives them from `build/icon.png`
 * at packaging time.
 *
 *   node scripts/icons.mjs          checks the copies
 *   node scripts/icons.mjs --write  copies the master over them
 */
import { createHash } from 'node:crypto'
import { copyFileSync, readFileSync } from 'node:fs'

const COPIES = [
  { master: 'build/icon.png', copies: ['src/renderer/public/twichat-logo.png', 'server/public/assets/twichat-logo.png'] },
  { master: 'src/renderer/public/twichat-logo-light.png', copies: ['server/public/assets/twichat-logo-light.png'] }
]

const write = process.argv.includes('--write')
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 12)
let stale = 0

for (const { master, copies } of COPIES) {
  const reference = digest(master)
  for (const copy of copies) {
    if (digest(copy) === reference) continue
    stale++
    if (write) { copyFileSync(master, copy); console.log(`${copy} rewritten from ${master}`) }
    else console.error(`${copy} differs from ${master}`)
  }
}

if (stale && !write) {
  console.error('Run `npm run icons -- --write` to align the copies.')
  process.exit(1)
}
console.log(stale ? `${stale} copy(ies) aligned.` : 'Logo copies up to date.')
