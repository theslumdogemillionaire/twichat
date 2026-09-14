import type { ChatMessage } from '../shared/types'

const cache = new WeakMap<ChatMessage, { body: ChatMessage; combined: ChatMessage }>()

/** Join only the exact body id emitted alongside a USERNOTICE. Raw messages remain available
 * for replies, emote offsets and moderation, and reappear alone if their event leaves history. */
export function groupNoticeMessages(messages: ChatMessage[]): ChatMessage[] {
  const byId = new Map(messages.map(message => [message.id, message]))
  const hidden = new Set<string>()
  const combined = new Map<string, ChatMessage>()
  for (const message of messages) {
    const notice = message.communityNotice
    const body = notice?.bodyId ? byId.get(notice.bodyId) : undefined
    if (!body || body === message || body.system || body.channel !== message.channel || body.login.toLowerCase() !== notice!.login) continue
    hidden.add(body.id)
    const existing = cache.get(message)
    if (existing?.body === body) combined.set(message.id, existing.combined)
    else {
      const row = { ...message, noticeBody: body }
      cache.set(message, { body, combined: row }); combined.set(message.id, row)
    }
  }
  return messages.filter(message => !hidden.has(message.id)).map(message => combined.get(message.id) ?? message)
}
