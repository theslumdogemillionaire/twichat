import { net } from 'electron'
import { fail } from '../shared/errors'
import { parseChatColor } from './chat-color-parse'

const COLOR = 'https://api.twitch.tv/helix/chat/color'

export interface ChatColorAuth { token: string; clientId: string }

const USER_ID = /^\d{1,30}$/

/**
 * The colour the account's name is written in.
 *
 * Reading it needs no scope of its own — Twitch takes any valid token here, which is why the
 * setting can show what is currently set even to an account that cannot yet change it.
 */
export async function getChatColor(userId: string, auth: ChatColorAuth): Promise<string> {
  if (!USER_ID.test(userId)) fail('chatColorNoAccount')
  const response = await net.fetch(`${COLOR}?user_id=${userId}`, {
    headers: { Authorization: `Bearer ${auth.token}`, 'Client-Id': auth.clientId },
    signal: AbortSignal.timeout(10000)
  })
  if (response.status === 401) fail('twitchSessionExpired')
  if (!response.ok) fail('chatColorUnavailable', response.status)
  const text = await response.text()
  if (text.length > 64 * 1024) fail('chatColorUnavailable', response.status)
  return parseChatColor(JSON.parse(text))
}

/**
 * Sets it. `color` is one of Twitch's fifteen named values, or a `#rrggbb` — and the second is
 * the one Twitch reserves for Turbo and Prime accounts, refusing it to everybody else with a 400
 * that says nothing about why. That refusal is the whole reason this function tells 400 apart
 * from the rest: everyone else gets sent back to the named list, which they can use.
 */
export async function setChatColor(userId: string, color: string, auth: ChatColorAuth): Promise<void> {
  if (!USER_ID.test(userId)) fail('chatColorNoAccount')
  const query = new URLSearchParams({ user_id: userId, color })
  const response = await net.fetch(`${COLOR}?${query}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${auth.token}`, 'Client-Id': auth.clientId },
    signal: AbortSignal.timeout(12000)
  })
  if (response.status === 204 || response.status === 200) return
  if (response.status === 401) fail('twitchSessionExpired')
  if (response.status === 400) fail(color.startsWith('#') ? 'chatColorNeedsTurbo' : 'chatColorRefused')
  fail('chatColorUnavailable', response.status)
}
