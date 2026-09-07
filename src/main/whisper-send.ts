import { net } from 'electron'
import { AppError, fail } from '../shared/errors'
import { channelName, whisperFailure } from '../shared/validation'

const SEND = 'https://api.twitch.tv/helix/whispers'

export interface WhisperAuth { token: string; clientId: string }

/** Twitch's id for a login, asked for only when a conversation has never given us one. */
export async function whisperRecipientId(login: string, auth: WhisperAuth): Promise<string> {
  const name = channelName(login)
  const response = await net.fetch(`https://api.twitch.tv/helix/users?login=${name}`, {
    headers: { Authorization: `Bearer ${auth.token}`, 'Client-Id': auth.clientId },
    signal: AbortSignal.timeout(10000)
  })
  if (response.status === 401) fail('twitchSessionExpired')
  if (!response.ok) fail('twitchProfileUnavailable')
  const payload = await response.json() as { data?: { id?: unknown }[] }
  const id = String(payload.data?.[0]?.id ?? '')
  if (!/^\d{1,30}$/.test(id)) fail('twitchAccountGone')
  return id
}

/**
 * Sends one whisper. Twitch answers `204 No Content` and nothing else — no id, no echo — which
 * is why the message written down afterwards carries an id of our own making: nothing will ever
 * come back to name it.
 */
export async function sendWhisper(from: string, to: string, text: string, auth: WhisperAuth): Promise<void> {
  if (!/^\d{1,30}$/.test(from)) fail('whisperNoAccount')
  if (!/^\d{1,30}$/.test(to)) fail('twitchAccountGone')
  // Twitch refuses a whisper to oneself, and the refusal reads like a bug rather than a rule.
  if (from === to) fail('whisperToSelf')
  const query = new URLSearchParams({ from_user_id: from, to_user_id: to })
  const response = await net.fetch(`${SEND}?${query}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${auth.token}`, 'Client-Id': auth.clientId, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: text }),
    signal: AbortSignal.timeout(12000)
  })
  if (response.status === 204) return
  throw new AppError(whisperFailure(response.status), [response.status])
}
