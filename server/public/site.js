const LOCALES = ['en', 'fr']
const current = LOCALES.includes(document.documentElement.lang) ? document.documentElement.lang : 'en'

const agent = navigator.userAgent
// Android carries "Linux" and iOS installs no desktop binary: mobile is ruled out first.
const mobile = /Android|iPhone|iPad|iPod/i.test(agent)
const platform = mobile ? 'mac' : /Windows/i.test(agent) ? 'windows' : /Linux|X11/i.test(agent) ? 'linux' : 'mac'
// The User-Agent does not reveal the distribution: on Linux there is no telling
// deb from rpm. Both are offered — deb by default (the desktop majority),
// rpm beside it.
const primary = platform === 'linux' ? 'deb' : platform
const labels = {
  fr: { mac: 'Télécharger pour macOS', windows: 'Télécharger pour Windows', linux: 'Télécharger pour Linux (.deb)' },
  en: { mac: 'Download for macOS', windows: 'Download for Windows', linux: 'Download for Linux (.deb)' }
}
for (const link of document.querySelectorAll('[data-download]')) {
  link.href = `/download?platform=${primary}&lang=${current}`
  if (!mobile && !link.classList.contains('nav-download')) link.textContent = labels[current][platform]
}

// The split button's menu: each entry forces a format, and the one detection
// picked is marked — detection stays a suggestion.
for (const item of document.querySelectorAll('[data-download-item]')) {
  item.href = `/download?platform=${item.dataset.downloadItem}&lang=${current}`
  if (item.dataset.downloadItem === primary) item.setAttribute('aria-current', 'true')
}

// A phone has nothing to install: handing it a disk image would be a download that ends in a
// file it cannot open. The buttons give way to the one sentence that is true there, and the
// header link points at the section instead of at the installer.
if (mobile) {
  for (const split of document.querySelectorAll('[data-download-split]')) split.hidden = true
  for (const note of document.querySelectorAll('[data-download-mobile]')) note.hidden = false
  for (const link of document.querySelectorAll('.nav-download')) link.href = '#download-title'
}

function closeDownloadMenus() {
  for (const menu of document.querySelectorAll('.download-split-menu')) menu.hidden = true
  for (const toggle of document.querySelectorAll('.download-split-toggle')) toggle.setAttribute('aria-expanded', 'false')
}

for (const split of document.querySelectorAll('[data-download-split]')) {
  const toggle = split.querySelector('.download-split-toggle')
  const menu = split.querySelector('.download-split-menu')
  if (!toggle || !menu) continue
  toggle.addEventListener('click', event => {
    event.stopPropagation()
    const willOpen = menu.hidden
    closeDownloadMenus()
    if (willOpen) {
      menu.hidden = false
      toggle.setAttribute('aria-expanded', 'true')
    }
  })
}

document.addEventListener('click', closeDownloadMenus)
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeDownloadMenus() })

/**
 * The language suggestion.
 *
 * The redirect from `/` is fixed and unnegotiated: it is here, in the browser, that the
 * visitor's language is read. A banner, never a panel laid over the content — an
 * interstitial on arrival is what search engines penalize on mobile, and this page is
 * precisely the indexed one. An explicit choice silences the suggestion for good.
 */
const CHOICE = 'twichat.lang'

function storedChoice() {
  try { return localStorage.getItem(CHOICE) } catch { return null }
}
function rememberChoice(locale) {
  try { localStorage.setItem(CHOICE, locale) } catch { /* Private browsing: the suggestion will come back, nothing worse. */ }
}

for (const link of document.querySelectorAll('.lang-switch a, .lang-banner-action')) {
  link.addEventListener('click', () => rememberChoice(link.getAttribute('hreflang') ?? current))
}

const banner = document.getElementById('lang-banner')
if (banner) {
  document.getElementById('lang-banner-close')?.addEventListener('click', () => {
    banner.hidden = true
    rememberChoice(current)
  })
  const preferred = [...(navigator.languages ?? [navigator.language ?? ''])]
    .map(tag => String(tag).toLowerCase().split('-')[0])
    .find(tag => LOCALES.includes(tag))
  // Nothing is offered to someone who already chose, or who already reads their language.
  if (!storedChoice() && preferred && preferred !== current) banner.hidden = false
}

// Real image links remain useful without JavaScript. The dialog adds a focused preview.
const strip = document.getElementById('screenshot-strip')
const lightbox = document.getElementById('screenshot-lightbox')
if (strip && lightbox && typeof lightbox.showModal === 'function') {
  const shots = [...strip.querySelectorAll('[data-screenshot]')]
  const previousStrip = document.querySelector('[data-gallery-prev]')
  const nextStrip = document.querySelector('[data-gallery-next]')
  const image = lightbox.querySelector('.lightbox-image')
  const stage = lightbox.querySelector('.lightbox-stage')
  const caption = lightbox.querySelector('.lightbox-caption')
  const counter = lightbox.querySelector('.lightbox-count')
  const zoom = lightbox.querySelector('.lightbox-zoom')
  let selected = 0
  let opener = null
  const reduced = matchMedia('(prefers-reduced-motion: reduce)')

  function updateStrip() {
    previousStrip.disabled = strip.scrollLeft <= 2
    nextStrip.disabled = strip.scrollLeft >= strip.scrollWidth - strip.clientWidth - 2
  }
  function moveStrip(direction) {
    const step = shots[1].offsetLeft - shots[0].offsetLeft
    strip.scrollBy({ left: step * direction, behavior: reduced.matches ? 'instant' : 'smooth' })
  }
  document.querySelector('.gallery-controls').hidden = false
  previousStrip.addEventListener('click', () => moveStrip(-1))
  nextStrip.addEventListener('click', () => moveStrip(1))
  strip.addEventListener('scroll', updateStrip, { passive: true })
  new ResizeObserver(updateStrip).observe(strip)
  updateStrip()

  function setZoom(enabled) {
    stage.classList.toggle('is-zoomed', enabled)
    zoom.setAttribute('aria-pressed', String(enabled))
    zoom.textContent = enabled ? zoom.dataset.fitLabel : zoom.dataset.zoomLabel
    stage.scrollTo({ left: 0, top: 0, behavior: 'instant' })
  }
  // The captures come in both themes; the strip only ever shows the one being read, so the
  // full-size image the link opens has to follow the same rule — including for a middle click,
  // which never reaches the dialog.
  const readingLight = () => document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'light'
    : matchMedia('(prefers-color-scheme: light)').matches
  function syncTheme() {
    for (const shot of shots) shot.href = readingLight() ? shot.dataset.shotLight : shot.dataset.shotDark
    if (lightbox.open) image.src = shots[selected].href
  }
  syncTheme()
  new MutationObserver(syncTheme).observe(document.documentElement, { attributeFilter: ['data-theme'] })
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', syncTheme)

  function showShot(index) {
    selected = (index + shots.length) % shots.length
    const shot = shots[selected]
    setZoom(false)
    image.src = shot.href
    image.alt = shot.querySelector('img').alt
    caption.textContent = `${selected + 1} / ${shots.length} · ${shot.querySelector('h3').textContent}`
    counter.textContent = `${selected + 1} / ${shots.length}`
  }
  for (const [index, shot] of shots.entries()) {
    shot.setAttribute('aria-haspopup', 'dialog')
    shot.addEventListener('click', event => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      event.preventDefault()
      opener = shot
      showShot(index)
      closeDownloadMenus()
      document.documentElement.classList.add('lightbox-open')
      lightbox.showModal()
    })
  }
  lightbox.querySelector('.lightbox-close').addEventListener('click', () => lightbox.close())
  lightbox.querySelector('[data-lightbox-prev]').addEventListener('click', () => showShot(selected - 1))
  lightbox.querySelector('[data-lightbox-next]').addEventListener('click', () => showShot(selected + 1))
  zoom.addEventListener('click', () => setZoom(zoom.getAttribute('aria-pressed') !== 'true'))
  image.addEventListener('click', () => setZoom(zoom.getAttribute('aria-pressed') !== 'true'))
  lightbox.addEventListener('keydown', event => {
    if (event.key === 'Tab') {
      const focusable = [...lightbox.querySelectorAll('button, [tabindex="0"]')]
      const first = focusable[0]
      const last = focusable.at(-1)
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
      return
    }
    // In zoom mode, arrows scroll the image; the visible navigation remains available.
    if (event.altKey || event.ctrlKey || event.metaKey || stage.classList.contains('is-zoomed')) return
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault()
      showShot(selected + (event.key === 'ArrowRight' ? 1 : -1))
    }
  })
  let backdropPress = false
  const outside = event => {
    const box = lightbox.getBoundingClientRect()
    return event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom
  }
  lightbox.addEventListener('pointerdown', event => { backdropPress = outside(event) })
  lightbox.addEventListener('click', event => {
    if (backdropPress && outside(event)) lightbox.close()
    backdropPress = false
  })
  lightbox.addEventListener('close', () => {
    document.documentElement.classList.remove('lightbox-open')
    setZoom(false)
    opener?.focus({ preventScroll: true })
  })
}

// Copying an address is the whole interaction: the button carries it, and the confirmation is
// announced rather than drawn, since the address stays visible either way. A refusal from the
// clipboard says nothing: the address is on screen and can still be selected by hand.
let copiedTimer
for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(button.dataset.copy) } catch { return }
    const status = document.querySelector('.donate-status')
    if (!status) return
    status.textContent = status.dataset.copied ?? ''
    clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => { status.textContent = '' }, 4000)
  })
}
