/**
 * Regenerates the light-theme blocks of `src/renderer/style.css` from the dark ramp.
 *
 * Single rule: on a light background a color keeps the contrast it had against the base
 * background in dark mode. The dark theme's visual hierarchy therefore survives the switch
 * without anyone picking 200 values by hand.
 *
 *   node scripts/palette.mjs          checks that the light blocks are up to date
 *   node scripts/palette.mjs --write  rewrites them
 */
import { readFileSync, writeFileSync } from 'node:fs'

const FILE = 'src/renderer/style.css'
const DARK_BASE_HEX = '#151718'
/** Background luminance in light mode. The only free setting of the conversion. */
const LIGHT_BASE = 0.905

const lin = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const gam = c => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)
const parseHex = hex => [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16) / 255)
const toHex = rgb => '#' + rgb.map(c => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, '0')).join('')
const luminance = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)

function rgbToOklch([r0, g0, b0]) {
  const r = lin(r0), g = lin(g0), b = lin(b0)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
  return { C: Math.hypot(A, B), H: (Math.atan2(B, A) * 180 / Math.PI + 360) % 360 }
}
function oklchToRgb(L, C, H) {
  const a = C * Math.cos(H * Math.PI / 180), b2 = C * Math.sin(H * Math.PI / 180)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b2) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b2) ** 3
  const s = (L - 0.0894841775 * a - 1.2914855480 * b2) ** 3
  return [
    gam(+4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    gam(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    gam(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s),
  ]
}
/** Lowers the chroma until the color fits inside sRGB, the way the browser would. */
function fit(L, C, H) {
  const ok = rgb => rgb.every(c => c >= -0.0005 && c <= 1.0005)
  if (ok(oklchToRgb(L, C, H))) return oklchToRgb(L, C, H)
  let lo = 0, hi = C
  for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (ok(oklchToRgb(L, mid, H))) lo = mid; else hi = mid }
  return oklchToRgb(L, lo, H)
}
function atLuminance(target, C, H) {
  let lo = 0, hi = 1
  for (let i = 0; i < 30; i++) { const mid = (lo + hi) / 2; if (luminance(fit(mid, C, H)) < target) lo = mid; else hi = mid }
  return fit((lo + hi) / 2, C, H)
}

const DARK_BASE = luminance(parseHex(DARK_BASE_HEX))
function flip(hex) {
  const rgb = parseHex(hex), { C, H } = rgbToOklch(rgb), Y = luminance(rgb)
  const ratio = Y >= DARK_BASE ? (Y + 0.05) / (DARK_BASE + 0.05) : (DARK_BASE + 0.05) / (Y + 0.05)
  const target = Y >= DARK_BASE ? (LIGHT_BASE + 0.05) / ratio - 0.05 : ratio * (LIGHT_BASE + 0.05) - 0.05
  return toHex(atLuminance(Math.min(1, Math.max(0, target)), C, H))
}

/**
 * What the conversion cannot decide. A shadow stays dark on a light background, and a
 * mechanical inversion would turn the accents almost black: they keep their hue, denser.
 */
const HAND_TUNED = [
  ['--shadow-1', 'rgba(31,38,33,.22)'], ['--shadow-2', 'rgba(31,38,33,.17)'], ['--shadow-3', 'rgba(31,38,33,.15)'],
  ['--shadow-4', 'rgba(31,38,33,.13)'], ['--shadow-5', 'rgba(31,38,33,.15)'], ['--shadow-6', 'rgba(31,38,33,.14)'],
  ['--shadow-7', 'rgba(31,38,33,.17)'], ['--shadow-8', 'rgba(31,38,33,.19)'], ['--shadow-9', 'rgba(31,38,33,.17)'],
  ['--scrim', 'rgba(28,33,29,.38)'], ['--hairline', 'rgba(20,26,20,.05)'],
  ['--accent-wash-16', 'rgba(107,152,30,.20)'], ['--accent-wash-08', 'rgba(107,152,30,.13)'],
  ['--accent-wash-07', 'rgba(107,152,30,.11)'], ['--accent-wash-04', 'rgba(107,152,30,.07)'],
  ['--lime', toHex(fit(0.545, 0.135, 129))], ['--amber', toHex(fit(0.555, 0.125, 84))],
]

// The markers are comment text in style.css: they must match it word for word.
const OPEN = '\n/* Light mode.'
const CLOSE = '\n/* Nickname colors'
const css = readFileSync(FILE, 'utf8')
const head = css.indexOf(OPEN), tail = css.indexOf(CLOSE)
if (head < 0 || tail < 0) throw new Error('Light-theme block markers not found in style.css.')

const rampBlock = css.slice(0, css.indexOf('\n}\n'))
const ramp = [...rampBlock.matchAll(/(--[ngryb]\d\d[a-z]?):(#[0-9a-f]{6})/g)]
if (!ramp.length) throw new Error('Dark ramp not found in style.css.')

/* A color hardcoded outside the ramp will never flip: better to say so right away. */
const stray = [...css.slice(css.indexOf('\n}\n'), head).matchAll(/#[0-9a-f]{3,6}\b/gi)]
  .map(match => match[0]).filter(hex => !['#111314', '#090b0b', '#050606', '#000', '#4e5549', '#696e6a', '#cdd1cb', '#ffd9d6', '#e9e8e3'].includes(hex.toLowerCase()))
if (stray.length) console.warn(`Warning: ${[...new Set(stray)].join(', ')} are hardcoded and will stay the same in both themes.`)

const families = ['n', 'g', 'r', 'y', 'b']
const lines = families
  .map(fam => ramp.filter(([, name]) => name[2] === fam).map(([, name, hex]) => `${name}:${flip(hex)}`).join(';'))
  .filter(Boolean)
  .join(';\n  ')
const block = `color-scheme:light;\n  ${lines};\n  ${HAND_TUNED.map(([name, value]) => `${name}:${value}`).join(';')}`
const next = css.slice(0, head) + `
/* Light mode. The block is written twice on purpose: with no inline script
   (the CSP forbids it) the system preference must live in the stylesheet. */
@media(prefers-color-scheme:light){:root:not([data-theme=dark]){
  ${block}
}}
:root[data-theme=light]{
  ${block}
}
` + css.slice(tail + 1)

if (next === css) { console.log(`Light theme up to date (${ramp.length} tokens).`); process.exit(0) }
if (!process.argv.includes('--write')) { console.error('The light theme drifted from the dark ramp. Rerun with --write.'); process.exit(1) }
writeFileSync(FILE, next)
console.log(`Light theme rewritten (${ramp.length} tokens).`)
