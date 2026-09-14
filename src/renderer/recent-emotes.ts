/**
 * The emotes and emojis last written, as the picker's "recent" tab reads them back.
 *
 * It lives here rather than inside the picker because it belongs to neither of the two: the room
 * and the conversation window each build their own panel, over one list in the browser store. A
 * panel that held the list in memory and wrote its own copy back would undo whatever the other
 * window recorded in the meantime, which is how a list ends up showing emotes nobody used lately.
 * So nothing is kept between calls — every write re-reads first, and every reader asks again.
 *
 * A key is `kind:value`, and the value may itself hold colons: Twitch names are punctuation
 * ("<3", ":)"), so only the first separator is one.
 */

const KEY = 'twichat.recent-emotes'
const LIMIT = 30

export type RecentKind = 'emote' | 'emoji'
export interface RecentPick { kind: RecentKind; value: string }

export const recentKey = (kind: RecentKind, value: string): string => `${kind}:${value}`

export function splitRecent(key: string): RecentPick | undefined {
  const separator = key.indexOf(':')
  const kind = key.slice(0, separator)
  const value = key.slice(separator + 1)
  if (!value || (kind !== 'emote' && kind !== 'emoji')) return undefined
  return { kind, value }
}

export function readRecents(): string[] {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown[]
    return Array.isArray(stored) ? stored.filter((item): item is string => typeof item === 'string' && !!splitRecent(item)).slice(0, LIMIT) : []
  } catch { return [] }
}

/** Puts one pick at the front of the shared list and answers with the list as it now stands. */
export function rememberRecent(kind: RecentKind, value: string): string[] {
  const key = recentKey(kind, value)
  const recents = [key, ...readRecents().filter(item => item !== key)].slice(0, LIMIT)
  try { localStorage.setItem(KEY, JSON.stringify(recents)) } catch { /* a store that refuses leaves the list as the panel drew it, and no longer */ }
  return recents
}
