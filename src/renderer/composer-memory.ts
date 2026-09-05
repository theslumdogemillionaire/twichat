import type { ReplyReference } from '../shared/types'

const HISTORY_LIMIT = 40

/**
 * What the composer keeps room by room: an unsent draft, the messages already sent, and the
 * message being replied to. A chat client remembers those across a room change — leaving a room
 * mid-sentence and coming back to it should find the sentence.
 *
 * It must not remember them across an *account* change. The rooms are keyed by name alone, and
 * two accounts share the room names: without the reset below, a sentence typed as one account
 * was handed to the next one to open the same room, in the same window. Signing out is the same
 * boundary — a draft left behind must not survive the session it was written in.
 */
export class ComposerMemory {
  private account: string | null = null
  private started = false
  private readonly drafts = new Map<string, string>()
  private readonly histories = new Map<string, string[]>()
  private readonly replies = new Map<string, ReplyReference>()

  /** Answers whether the account changed, which is when everything written under it is dropped. */
  setAccount(login: string | null): boolean {
    if (this.started && login === this.account) return false
    this.started = true
    this.account = login
    this.clear()
    return true
  }

  /** The account a message being sent belongs to, read back when the send finally answers. */
  get scope(): string | null { return this.account }

  clear() {
    this.drafts.clear()
    this.histories.clear()
    this.replies.clear()
  }

  draft(room: string): string { return this.drafts.get(room) ?? '' }
  keepDraft(room: string, text: string) {
    if (!room) return
    if (text) this.drafts.set(room, text)
    else this.drafts.delete(room)
  }
  dropDraft(room: string) { this.drafts.delete(room) }

  history(room: string): string[] { return this.histories.get(room) ?? [] }
  /** A sent message joins its room's history once, at the front, however often it is repeated. */
  remember(room: string, text: string) {
    if (!room || !text) return
    this.histories.set(room, [text, ...this.history(room).filter(entry => entry !== text)].slice(0, HISTORY_LIMIT))
  }

  reply(room: string): ReplyReference | undefined { return this.replies.get(room) }
  setReply(room: string, target: ReplyReference | null) {
    if (!room) return
    if (target) this.replies.set(room, target)
    else this.replies.delete(room)
  }
}
