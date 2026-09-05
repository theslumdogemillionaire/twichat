import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_LOCALE, HEAD, LOCALES, MESSAGES, STRUCTURED, STRUCTURED_LANGUAGE } from './site-messages.mjs'

/**
 * The site is served as complete HTML, one URL per language.
 *
 * Each page is built once at startup then kept in memory: the redirect from `/` is fixed
 * and detection happens in the browser, so nothing depends on the `Accept-Language`
 * header. Pages stay cacheable, with no `Vary`, and a shared link always opens the
 * language it names.
 */
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])

/** The end of the element opened at `from`, counting nested elements of the same name. */
function closingIndex(html, tag, from) {
  const pattern = new RegExp(`</?${tag}\\b[^>]*>`, 'g')
  pattern.lastIndex = from
  let depth = 1
  for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
    if (VOID.has(tag)) return match.index
    depth += match[0].startsWith('</') ? -1 : 1
    if (depth === 0) return match.index
  }
  return -1
}

function escapeAttribute(value) {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}

/**
 * Replaces marked content and attributes with their text in the requested language.
 *
 * A key absent from the catalog throws instead of being skipped. Skipping it would leave
 * the template's own text in place, and since the template is written in English that is
 * English silently shipped onto the French page. Pages are built at startup, so the boot
 * and `site:check` fail rather than the site publishing the wrong language.
 */
function translate(html, messages, locale) {
  // Replacements are collected on the original document then applied from the end toward
  // the start: no index shift to track, and translated text can never be read back.
  const edits = []
  for (const marker of ['data-i18n', 'data-i18n-text']) {
    const pattern = new RegExp(`<(\\w+)[^>]*\\s${marker}="([^"]+)"[^>]*>`, 'g')
    for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
      const [opening, tag, key] = match
      const value = messages[key]
      if (value === undefined) throw new Error(`${marker}="${key}" has no text in ${locale}`)
      const start = match.index + opening.length
      const end = closingIndex(html, tag, start)
      if (end < 0) continue
      const inner = html.slice(start, end)
      // `data-i18n` replaces the whole content; `data-i18n-text` touches only the first text
      // run, and only over its own range: the icons before it stay in place and a nested
      // translation is not overwritten by its parent's.
      const run = /^((?:\s*<[^>]*>(?:[^<]*<\/[^>]*>)?)*\s*)([^<]*)/.exec(inner) ?? ['', '', inner]
      edits.push(marker === 'data-i18n'
        ? { start, end, text: value }
        : { start: start + run[1].length, end: start + run[1].length + run[2].length, text: value })
    }
  }
  let out = html
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end)
  }
  // `data-i18n-attr="attribute=key;attribute=key"`.
  return out.replace(/<(\w+)([^>]*)\sdata-i18n-attr="([^"]+)"([^>]*)>/g, (all, tag, before, pairs, after) => {
    let attrs = `${before}${after}`
    for (const pair of pairs.split(';')) {
      const [name, key] = pair.split('=')
      if (!name) throw new Error(`data-i18n-attr="${pairs}" is malformed`)
      const value = messages[key]
      if (value === undefined) throw new Error(`data-i18n-attr ${name}="${key}" has no text in ${locale}`)
      const existing = new RegExp(`\\s${name}="[^"]*"`)
      attrs = existing.test(attrs) ? attrs.replace(existing, ` ${name}="${escapeAttribute(value)}"`) : `${attrs} ${name}="${escapeAttribute(value)}"`
    }
    return `<${tag}${attrs}>`
  })
}

/** The document head: this is what search engines read, so it is rewritten in full. */
function rewriteHead(html, locale, origin) {
  const head = HEAD[locale]
  const canonical = `${origin}/${locale}/`
  const alternates = LOCALES.map(other => `<link rel="alternate" hreflang="${other}" href="${origin}/${other}/">`).join('\n    ')
  return html
    .replace(/<html lang="[^"]*"/, `<html lang="${locale}"`)
    .replace(/<title[^>]*>[^<]*<\/title>/, `<title>${head.title}</title>`)
    .replace(/(<meta name="description" content=")[^"]*"/, `$1${escapeAttribute(head.description)}"`)
    .replace(/(<meta property="og:title" content=")[^"]*"/, `$1${escapeAttribute(head.ogTitle)}"`)
    .replace(/(<meta property="og:description" content=")[^"]*"/, `$1${escapeAttribute(head.ogDescription)}"`)
    .replace(/(<meta property="og:image:alt" content=")[^"]*"/, `$1${escapeAttribute(head.imageAlt)}"`)
    .replace(/(<meta property="og:url" content=")[^"]*"/, `$1${canonical}"`)
    .replace(/(<meta property="og:locale" content=")[^"]*"/, `$1${head.ogLocale}"`)
    .replace(/(<meta name="twitter:title" content=")[^"]*"/, `$1${escapeAttribute(head.twitterTitle)}"`)
    .replace(/(<meta name="twitter:description" content=")[^"]*"/, `$1${escapeAttribute(head.twitterDescription)}"`)
    .replace(/(<meta name="twitter:image:alt" content=")[^"]*"/, `$1${escapeAttribute(head.imageAlt)}"`)
    .replace(/<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${canonical}">`)
    // `x-default` names the page served when no language matches: the one the redirect uses.
    .replace(/<link rel="alternate" hreflang="[^"]*" href="[^"]*">/,
      `${alternates}\n    <link rel="alternate" hreflang="x-default" href="${origin}/${DEFAULT_LOCALE}/">`)
    .replace(/<meta property="og:locale:alternate"[^>]*>\s*/g, '')
    .replace(`<meta property="og:locale" content="${head.ogLocale}">`,
      `<meta property="og:locale" content="${head.ogLocale}">\n    ` +
      LOCALES.filter(other => other !== locale).map(other => `<meta property="og:locale:alternate" content="${HEAD[other].ogLocale}">`).join('\n    '))
}

/**
 * The language switcher and the suggestion banner. The banner is a banner, not an
 * interstitial: a panel laid over the content on arrival is what search engines penalize
 * on mobile, and this is precisely the indexed landing page.
 */
function injectLanguageControls(html, locale) {
  const other = LOCALES.find(entry => entry !== locale) ?? DEFAULT_LOCALE
  // Two segments, like the theme switch next to it: the language being read is marked, the other
  // is one click away. The codes are enough — the full name is left to the screen reader.
  const switcher = `<div class="lang-switch" role="group" aria-label="${escapeAttribute(HEAD[locale].switcherLabel)}">` +
    LOCALES.map(entry => entry === locale
      ? `<span aria-current="page" lang="${entry}">${entry.toUpperCase()}</span>`
      : `<a href="/${entry}/" hreflang="${entry}" lang="${entry}" rel="alternate" aria-label="${escapeAttribute(HEAD[entry].languageName)}">${entry.toUpperCase()}</a>`
    ).join('') + '</div>'
  const banner = `<div id="lang-banner" class="lang-banner" role="region" lang="${other}" aria-label="${escapeAttribute(HEAD[other].bannerText)}" hidden>` +
    `<span data-lang-text>${HEAD[other].bannerText}</span>` +
    `<a class="lang-banner-action" href="/${other}/" hreflang="${other}" lang="${other}">${HEAD[other].bannerAction}</a>` +
    `<button type="button" id="lang-banner-close" aria-label="${escapeAttribute(HEAD[other].bannerDismiss)}">×</button></div>`
  return html
    .replace('<button id="theme-toggle"', `${switcher}<button id="theme-toggle"`)
    .replace('</body>', `${banner}\n  </body>`)
}

/**
 * The page's structured data, translated. The question text is already in the catalog
 * since it is visible; the rest goes through `STRUCTURED`, which is keyed by the English
 * source. An unknown string is left intact rather than lost.
 */
const VOCABULARY = new Set(['@context', '@type', '@id'])

function translateStructuredData(html, locale, origin) {
  const englishToKey = new Map(Object.entries(MESSAGES.en).map(([key, value]) => [value, key]))
  const translate = value => {
    const key = englishToKey.get(value)
    if (key && MESSAGES[locale][key] !== undefined) return MESSAGES[locale][key]
    if (STRUCTURED[value] !== undefined) return locale === 'en' ? value : STRUCTURED[value]
    return value
  }
  const walk = node => {
    if (Array.isArray(node)) return node.map(walk)
    if (node && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).map(([key, value]) => {
        if (key === 'inLanguage') return [key, STRUCTURED_LANGUAGE[locale]]
        // A page URL (root or anchor) names this language's version; the `@id` values stay
        // as they are, they are identifiers and not addresses to follow.
        if (key === 'url' && typeof value === 'string') {
          const page = /^https?:\/\/[^/]+\/?(#[\w-]*)?$/.exec(value)
          if (page) return [key, `${origin}/${locale}/${page[1] ?? ''}`]
        }
        // Only the vocabulary tokens are untouchable; `@graph` carries the data.
        return [key, VOCABULARY.has(key) ? value : walk(value)]
      }))
    }
    return typeof node === 'string' ? translate(node) : node
  }
  return html.replace(/(<script type="application\/ld\+json">)([\s\S]*?)(<\/script>)/, (all, open, body, close) => {
    try { return `${open}${JSON.stringify(walk(JSON.parse(body)), null, 2)}${close}` }
    catch { return all }
  })
}

/**
 * The screenshots show the app: each page serves the one for its language.
 * The template names the file without a language, the build inserts its own.
 */
function localiseAssets(html, locale) {
  return html.replace(/\/assets\/(app-[a-z-]+)\.(png|webp)/g, (all, name, extension) => `/assets/${name}.${locale}.${extension}`)
}

/** The document's internal links lead to the anchors of the same language, not to the root. */
function localiseLinks(html, locale) {
  return html.replace(/href="\/(#[\w-]*)?"/g, (_all, anchor) => `href="/${locale}/${anchor ?? ''}"`)
}

/** Builds the pages at startup: one file read, once, before listening. */
export function buildPages(root, origin) {
  const template = readFileSync(join(root, 'index.html'), 'utf8')
  const pages = {}
  for (const locale of LOCALES) {
    let html = translate(template, MESSAGES[locale], locale)
    html = rewriteHead(html, locale, origin)
    html = translateStructuredData(html, locale, origin)
    html = injectLanguageControls(html, locale)
    pages[locale] = localiseAssets(localiseLinks(html, locale), locale)
  }
  return pages
}

/**
 * The error page follows the same rule as the rest of the site: one version per language, chosen
 * from the requested URL's prefix. It stays `noindex`, so neither canonical nor alternates.
 */
export function buildNotFound(root) {
  const template = readFileSync(join(root, '404.html'), 'utf8')
  const pages = {}
  for (const locale of LOCALES) {
    const html = translate(template, MESSAGES[locale], locale).replace(/<html lang="[^"]*"/, `<html lang="${locale}"`)
    pages[locale] = localiseLinks(html, locale)
  }
  return pages
}

export function sitemap(origin) {
  const entries = LOCALES.map(locale => {
    const alternates = LOCALES.map(other => `      <xhtml:link rel="alternate" hreflang="${other}" href="${origin}/${other}/"/>`).join('\n')
    return `  <url>\n    <loc>${origin}/${locale}/</loc>\n${alternates}\n      <xhtml:link rel="alternate" hreflang="x-default" href="${origin}/${DEFAULT_LOCALE}/"/>\n  </url>`
  }).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${entries}\n</urlset>\n`
}
