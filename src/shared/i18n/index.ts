import { fr } from './fr'
import { en } from './en'

export type { Messages } from './en'
export { fr } from './fr'
export { en } from './en'

export const LOCALES = ['fr', 'en'] as const
export type Locale = typeof LOCALES[number]

/** Each language's name in its own language: an endonym is recognized without being able to read the page. */
export const LOCALE_ENDONYMS: Record<Locale, string> = { fr: 'Français', en: 'English' }

const CATALOGS = { fr, en }

/**
 * The current catalog. It is a live link: `import { m }` then `m.session.enter` always reads
 * the active language. Never capture it at module load: a `const label = m.session.enter`
 * at the top of a file would stay frozen on English.
 */
export let m = CATALOGS.en
export let locale: Locale = 'en'

/** The formatters follow the language: they are rebuilt on each switch, not on each call. */
export let numbers = new Intl.NumberFormat('en')
export let compactNumbers = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })
export let clock = new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit' })
export let collator = new Intl.Collator('en')

export function setLocale(next: Locale): void {
  locale = next
  m = CATALOGS[next]
  numbers = new Intl.NumberFormat(next)
  compactNumbers = new Intl.NumberFormat(next, { notation: 'compact', maximumFractionDigits: 1 })
  clock = new Intl.DateTimeFormat(next, { hour: '2-digit', minute: '2-digit' })
  collator = new Intl.Collator(next)
}

export function isLocale(value: unknown): value is Locale {
  return (LOCALES as readonly string[]).includes(value as string)
}

/**
 * The language kept: the account's explicit choice first, otherwise the first system
 * language we know how to speak. Only the language subtag counts, so `fr-CA` means `fr`;
 * with no match we fall back to English, the project's default language.
 */
export function resolveLocale(stored: string, preferred: readonly string[] = []): Locale {
  if (isLocale(stored)) return stored
  for (const candidate of preferred) {
    const language = candidate.toLowerCase().split(/[-_]/)[0]
    if (isLocale(language)) return language
  }
  return 'en'
}

/** A language's name in the current language, for the content language lists. */
export function languageName(tag: string): string {
  try { return new Intl.DisplayNames([locale], { type: 'language' }).of(tag) ?? tag }
  catch { return tag }
}

