import type { DatabaseSync } from 'node:sqlite'
import type { Whisper } from '../shared/types'
import { channelName } from '../shared/validation'

interface WhisperRow {
  id: string
  peer_login: string
  peer_id: string
  peer_name: string
  outgoing: number
  text: string
  sent_at: number
}

const rowToWhisper = (row: WhisperRow): Whisper => ({
  id: row.id, peer: row.peer_login, peerId: row.peer_id || undefined, peerName: row.peer_name || row.peer_login,
  outgoing: row.outgoing !== 0, text: row.text, at: row.sent_at
})

/**
 * The whispers on this machine, scoped to the account that received them. It is the only store
 * in the application whose loss cannot be made good: Twitch replays a chat room, and it does keep
 * whispers — they are all in its own inbox — but it exposes no way to read them back. EventSub
 * delivers each one once, to whoever was connected. What misses this table is not late; it is out
 * of reach until someone opens twitch.tv.
 */
export class WhisperStore {
  constructor(private readonly database: DatabaseSync) {}

  /**
   * Writes one whisper down. Returns false when that id was already there: EventSub can repeat a
   * frame across a reconnect, and the same message must not become two lines of a conversation.
   */
  record(scope: string, whisper: Whisper): boolean {
    const peer = channelName(whisper.peer)
    const id = whisper.id.trim()
    const text = whisper.text.trim()
    if (!id || id.length > 100 || !text) return false
    const at = Number.isFinite(whisper.at) && whisper.at > 0 ? Math.floor(whisper.at) : Date.now()
    this.database.exec('BEGIN IMMEDIATE')
    try {
      // The scope row may not exist yet — an account whose preferences were never saved. Same
      // hand as the channel activity: the row is opened rather than the whisper refused.
      this.database.prepare('INSERT INTO scopes (scope, updated_at) VALUES (?, ?) ON CONFLICT(scope) DO NOTHING').run(scope, at)
      const peerId = /^\d{1,30}$/.test(whisper.peerId ?? '') ? whisper.peerId! : ''
      const written = this.database.prepare(`INSERT INTO whispers (scope, id, peer_login, peer_id, peer_name, outgoing, text, sent_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(scope, id) DO NOTHING`)
        .run(scope, id, peer, peerId, (whisper.peerName || peer).slice(0, 60), whisper.outgoing ? 1 : 0, text, at)
      this.database.exec('COMMIT')
      return Number(written.changes) > 0
    } catch (error) { this.database.exec('ROLLBACK'); throw error }
  }

  /** One conversation, oldest first, capped: a thread is read to be shown, not to be counted. */
  thread(scope: string, peer: string, limit = 200): Whisper[] {
    const rows = this.database.prepare(`SELECT id, peer_login, peer_id, peer_name, outgoing, text, sent_at FROM whispers
      WHERE scope = ? AND peer_login = ? ORDER BY sent_at DESC, rowid DESC LIMIT ?`)
      .all(scope, channelName(peer), Math.max(1, Math.min(1000, Math.floor(limit)))) as unknown as WhisperRow[]
    return rows.map(rowToWhisper).reverse()
  }

  /**
   * Twitch's id for someone we have heard from, the most recent one they were seen under. A
   * reply goes to an id, and the one Twitch sent with their whisper spares a lookup — and holds
   * where a login no longer would.
   */
  peerId(scope: string, peer: string): string {
    const row = this.database.prepare(`SELECT peer_id FROM whispers
      WHERE scope = ? AND peer_login = ? AND peer_id <> '' ORDER BY sent_at DESC LIMIT 1`)
      .get(scope, channelName(peer)) as { peer_id?: string } | undefined
    return typeof row?.peer_id === 'string' ? row.peer_id : ''
  }

  /** Everything said with one person, gone from this machine. Twitch keeps its own copy. */
  forget(scope: string, peer: string): void {
    this.database.prepare('DELETE FROM whispers WHERE scope = ? AND peer_login = ?').run(scope, channelName(peer))
  }
}
