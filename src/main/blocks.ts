import { net } from 'electron'
import { fail } from '../shared/errors'
import type { BlockedUser } from '../shared/types'
import { parseBlockedUsers } from './blocks-parse'

const BLOCKS = 'https://api.twitch.tv/helix/users/blocks'

export interface BlockAuth { token: string; clientId: string }

/** Twitch's ceiling per page, and enough pages for a list nobody builds by hand. */
const PAGE = 100
const PAGES = 30
const MAX_BODY = 2 * 1024 * 1024

const USER_ID = /^\d{1,30}$/

/**
 * Twitch answers a token that was never granted `user:read:blocked_users` with a 401 — the same
 * status as a dead session, and never a 403. Telling the two apart from the outside is therefore
 * impossible, which is why the caller checks the scope on the validated token before ever getting
 * here: a 401 reaching this line means the session, not the grant.
 */
async function read(url: string, { token, clientId }: BlockAuth): Promise<unknown> {
  const response = await net.fetch(url, {
    headers: { Authorization: `Bearer ${token}`, 'Client-Id': clientId },
    signal: AbortSignal.timeout(10000)
  })
  if (response.status === 401) fail('twitchSessionExpired')
  if (!response.ok) fail('blocksUnavailable', response.status)
  const text = await response.text()
  if (text.length > MAX_BODY) fail('blocksTooLarge')
  return JSON.parse(text)
}

/** Everyone the account has blocked, every page of them. */
export async function getBlockedUsers(userId: string, auth: BlockAuth): Promise<BlockedUser[]> {
  if (!USER_ID.test(userId)) fail('blocksNoAccount')
  const users: BlockedUser[] = []
  let cursor = ''
  for (let page = 0; page < PAGES; page++) {
    const query = new URLSearchParams({ broadcaster_id: userId, first: String(PAGE) })
    if (cursor) query.set('after', cursor)
    const answer = parseBlockedUsers(await read(`${BLOCKS}?${query}`, auth))
    users.push(...answer.users)
    // Empty pagination is the last page. A cursor that answers itself is a page Twitch cannot
    // advance past, and asking again would only ask for it again — the ceiling above would end
    // that in the end, this ends it now.
    if (!answer.cursor || answer.cursor === cursor) break
    cursor = answer.cursor
  }
  return users
}

/**
 * Blocks or unblocks someone, on the real Twitch account. `PUT` and `DELETE` differ by the verb
 * alone, and Twitch answers both with a bare 204 — and with the same 204 when nothing changed,
 * which is why the list is re-read afterwards rather than patched from a guess about what took.
 */
async function change(method: 'PUT' | 'DELETE', targetId: string, auth: BlockAuth): Promise<void> {
  if (!USER_ID.test(targetId)) fail('twitchAccountGone')
  const query = new URLSearchParams({ target_user_id: targetId })
  const response = await net.fetch(`${BLOCKS}?${query}`, {
    method,
    headers: { Authorization: `Bearer ${auth.token}`, 'Client-Id': auth.clientId },
    signal: AbortSignal.timeout(12000)
  })
  if (response.status === 204 || response.status === 200) return
  if (response.status === 401) fail('twitchSessionExpired')
  // 400 here is Twitch refusing the pair rather than the call: blocking oneself is the one it names.
  if (response.status === 400) fail('blockRefused')
  fail('blocksUnavailable', response.status)
}

export const blockUser = (targetId: string, auth: BlockAuth) => change('PUT', targetId, auth)
export const unblockUser = (targetId: string, auth: BlockAuth) => change('DELETE', targetId, auth)
