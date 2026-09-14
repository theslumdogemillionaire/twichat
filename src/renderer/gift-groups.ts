import type { ChatMessage, GiftRecipient } from '../shared/types'

const WINDOW_MS = 10_000
const grouped = new WeakMap<ChatMessage, { key: string; message: ChatMessage }>()

export function giftIsForAccount(message: ChatMessage, account: string | null): boolean {
  if (!account) return false
  const login = account.toLowerCase()
  return message.gift?.recipient?.login === login || message.giftRecipients?.some(recipient => recipient.login === login) === true
}

/** Presentation only. IRC supplies no documented batch id: match one unambiguous, recent
 * announcement by channel, sender and tier, capped at its advertised count. Raw notices
 * stay in ChatStore, so moderation, history eviction and a later ambiguity lose no data. */
export function groupGiftMessages(messages: ChatMessage[]): ChatMessage[] {
  const batches = messages.filter(message => message.gift?.kind === 'community' && message.gift.login && message.gift.plan && message.gift.count)
  if (!batches.length) return messages
  const members = new Map<ChatMessage, ChatMessage[]>()
  const hidden = new Set<ChatMessage>()
  for (const message of messages) {
    const gift = message.gift
    if (gift?.kind !== 'single' || !gift.login || !gift.recipient?.login || (gift.months ?? 1) > 1) continue
    // Include full batches when checking ambiguity; a later direct gift must not spill into
    // a second overlapping batch just because the first one has reached its count.
    const candidates = batches.filter(batch => batch.channel === message.channel && batch.gift!.login === gift.login && batch.gift!.plan === gift.plan && message.time >= batch.time && message.time - batch.time <= WINDOW_MS)
    if (candidates.length !== 1) continue
    const batch = candidates[0]
    const recipients = members.get(batch) ?? []
    if (recipients.length >= batch.gift!.count! || recipients.some(item => item.gift!.recipient!.login === gift.recipient!.login)) continue
    recipients.push(message); members.set(batch, recipients); hidden.add(message)
  }
  return messages.filter(message => !hidden.has(message)).map(message => {
    const recipients = members.get(message)
    if (!recipients?.length) return message
    const key = recipients.map(item => item.id).join('\n')
    const cached = grouped.get(message)
    if (cached?.key === key) return cached.message
    const giftRecipients: GiftRecipient[] = recipients.map(item => item.gift!.recipient!)
    const combined = { ...message, giftRecipients }
    grouped.set(message, { key, message: combined })
    return combined
  })
}
