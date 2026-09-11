import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

// Requires cwebp and ImageMagick. Originals stay intact for the screenshot lightbox.
const assets = fileURLToPath(new URL('../server/public/assets/', import.meta.url))
for (const name of readdirSync(assets).filter(name => /^app-[a-z-]+\.(fr|en)\.png$/.test(name))) {
  execFileSync('cwebp', ['-quiet', '-resize', '640', '0', '-q', '85', '-m', '6', join(assets, name), '-o', join(assets, name.replace(/\.png$/, '.640.webp'))])
}
for (const [size, name] of [[96, 'twichat-logo-small.png'], [48, 'favicon.png']]) {
  execFileSync('magick', [join(assets, 'twichat-logo.png'), '-resize', `${size}x${size}`, '-strip', join(assets, name)])
}
console.log('Responsive screenshots, compact logo and favicon generated.')
