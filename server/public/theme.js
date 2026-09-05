// Loaded before paint: the theme is set on the root before the page shows, otherwise a light
// setting would flash dark as it opens. With no setting, the stylesheet falls back to
// `prefers-color-scheme` and follows the system on its own.
const STORAGE = 'twichat-theme'
const THEMES = ['system', 'light', 'dark']
// The button title is written here, after the build has translated the markup, so it carries
// its own table: this script runs before paint, with no module and no access to the catalog.
// `site.js` shares this global scope and already declares `LOCALES`: a second one of the same
// name is a syntax error, and it would take the whole of `site.js` down with it.
const THEME_LOCALES = ['en', 'fr']
const lang = THEME_LOCALES.includes(document.documentElement.lang) ? document.documentElement.lang : 'en'
const LABELS = {
  fr: { system: 'Thème du système', light: 'Thème clair', dark: 'Thème sombre', shownLight: 'clair', shownDark: 'sombre' },
  en: { system: 'System theme', light: 'Light theme', dark: 'Dark theme', shownLight: 'light', shownDark: 'dark' }
}[lang]

function stored() {
  try {
    const value = localStorage.getItem(STORAGE)
    return THEMES.includes(value) ? value : 'system'
  } catch { return 'system' }
}

function resolved(theme) {
  if (theme !== 'system') return theme
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

function apply(theme) {
  if (theme === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = theme

  // The hero screenshot follows the rendered theme: two sources, only one active at a time.
  const shot = resolved(theme)
  for (const source of document.querySelectorAll('[data-shot]')) {
    source.media = source.dataset.shot === shot ? 'all' : 'not all'
  }
  // The comparison layer always shows the other theme; it loads only on the first hover.
  const peek = document.querySelector('.hero-peek')
  if (peek && peek.src) peek.src = shot === 'dark' ? peek.dataset.shotLight : peek.dataset.shotDark
  const button = document.querySelector('#theme-toggle')
  if (button) {
    // The switch shows the displayed state, not the setting: in system mode it follows the OS.
    button.setAttribute('aria-checked', String(shot === 'dark'))
    button.title = theme === 'system' ? `${LABELS.system} (${shot === 'dark' ? LABELS.shownDark : LABELS.shownLight})` : LABELS[theme]
  }
}

apply(stored())

let fade = 0

document.addEventListener('DOMContentLoaded', () => {
  const current = stored()
  apply(current)
  const button = document.querySelector('#theme-toggle')
  if (!button) return
  const hero = document.querySelector('.hero-window')
  const peek = document.querySelector('.hero-peek')
  const still = matchMedia('(prefers-reduced-motion: reduce)')

  // The theme flips at the end of the diagonal: the layer finishes its run, then the page takes its color.
  function settle(next) {
    // The fade arms just before the flip and disarms as soon as it ends: outside a click, the page carries no transition.
    document.documentElement.classList.add('theme-switching')
    clearTimeout(fade)
    fade = setTimeout(() => document.documentElement.classList.remove('theme-switching'), 400)
    try { localStorage.setItem(STORAGE, next) } catch { /* private browsing: the choice only holds for this page */ }
    apply(next)
    if (!hero) return
    // Both images are now the same: the layer folds back without animation, nobody sees it go.
    hero.classList.add('peek-instant')
    hero.classList.remove('peeking', 'peek-full')
    void hero.offsetWidth
    hero.classList.remove('peek-instant')
  }

  // Day or night: the switch flips to the opposite of what is displayed.
  button.addEventListener('click', () => {
    const next = resolved(stored()) === 'dark' ? 'light' : 'dark'
    // Keyboard or touch with no prior hover: the image is still missing, so the flip happens without the wipe.
    if (peek && !peek.src) peek.src = resolved(stored()) === 'dark' ? peek.dataset.shotLight : peek.dataset.shotDark
    const wipeable = hero && peek && peek.complete && peek.naturalWidth > 0 && !still.matches
    if (!wipeable) { settle(next); return }
    hero.classList.add('peeking', 'peek-full')
    setTimeout(() => settle(next), 500)
  })
  // Hovering the switch reveals the other theme on the screenshot, on a diagonal.
  if (hero && peek) {
    const reveal = show => {
      if (show && !peek.src) peek.src = resolved(stored()) === 'dark' ? peek.dataset.shotLight : peek.dataset.shotDark
      if (!hero.classList.contains('peek-full')) hero.classList.toggle('peeking', show)
    }
    button.addEventListener('pointerenter', () => reveal(true))
    button.addEventListener('pointerleave', () => reveal(false))
    button.addEventListener('focus', () => reveal(true))
    button.addEventListener('blur', () => reveal(false))
  }

  // The system changes its mind (the automatic evening switch): with no explicit setting, the page follows.
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (stored() === 'system') apply('system') })
})
