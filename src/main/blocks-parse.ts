import type { BlockedUser } from '../shared/types'

/** Twitch ids are numeric strings; a login is what `channelName` would accept, unchanged. */
const USER_ID = /^\d{1,30}$/
const LOGIN = /^[a-z0-9_]{1,25}$/
const CURSOR = /^[A-Za-z0-9_=+/-]{1,500}$/
const MAX_NAME = 60

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/**
 * One page of `users/blocks`. Twitch orders it by when the block was set, most recent first,
 * which is the order the list keeps: nothing here sorts it, because nothing here knows better.
 *
 * An entry missing its login is dropped rather than repaired. The login is the key everything
 * else compares against — a chat message carries one, not an id — so an entry without one could
 * never hide anybody, and keeping it would only make the count lie.
 */
export function parseBlockedUsers(payload: unknown): { users: BlockedUser[]; cursor: string } {
  const values = Array.isArray(object(payload)?.data) ? object(payload)!.data as unknown[] : []
  const users: BlockedUser[] = []
  for (const value of values) {
    const item = object(value)
    const login = typeof item?.user_login === 'string' ? item.user_login.trim().toLowerCase() : ''
    const userId = typeof item?.user_id === 'string' ? item.user_id : String(item?.user_id ?? '')
    if (!LOGIN.test(login) || !USER_ID.test(userId)) continue
    const displayName = typeof item?.display_name === 'string' ? item.display_name.trim().slice(0, MAX_NAME) : ''
    users.push({ login, userId, displayName: displayName || login })
  }
  const cursor = object(object(payload)?.pagination)?.cursor
  return { users, cursor: typeof cursor === 'string' && CURSOR.test(cursor) ? cursor : '' }
}
