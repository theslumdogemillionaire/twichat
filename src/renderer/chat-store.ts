import type { ChatMessage } from '../shared/types'
export const HISTORY_LIMIT = 500
export class ChatStore {
  private rooms = new Map<string, ChatMessage[]>()
  get(channel: string): ChatMessage[] { return this.rooms.get(channel) ?? [] }
  add(message: ChatMessage) {
    const messages = this.get(message.channel)
    if (messages.some(item => item.id === message.id)) return
    const optimistic = messages.findIndex(item => item.own && !message.own && item.login === message.login && item.text === message.text && item.action === message.action && Math.abs(item.time - message.time) < 5000)
    if (optimistic >= 0) { messages[optimistic] = { ...message, own: true }; return }
    messages.push(message)
    if (messages.length > HISTORY_LIMIT) messages.splice(0, messages.length - HISTORY_LIMIT)
    this.rooms.set(message.channel, messages)
  }
  clear(channel: string, user?: string, id?: string) {
    if (!user && !id) this.rooms.set(channel, [])
    else this.rooms.set(channel, this.get(channel).filter(message => id ? message.id !== id : message.login.toLowerCase() !== user))
  }
  remove(channel: string) { this.rooms.delete(channel) }
  /** Messages belong to the account that read them: switching accounts throws them all away. */
  reset() { this.rooms.clear() }
}
