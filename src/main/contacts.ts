import type { DatabaseSync } from 'node:sqlite'
import { channelName } from '../shared/validation'

/**
 * Someone kept on purpose. `note` is what no Twitch field holds — where you met, what they
 * stream, why you added them — and it is the reason this table exists rather than a list of
 * logins the application could have rebuilt from the chat.
 */
export interface Contact {
  login: string
  userId: string
  displayName: string
  note: string
  addedAt: number
}

interface ContactRow {
  login: string
  user_id: string
  display_name: string
  note: string
  added_at: number
}

const rowToContact = (row: ContactRow): Contact => ({
  login: row.login, userId: row.user_id, displayName: row.display_name || row.login,
  note: row.note, addedAt: row.added_at
})

/**
 * The address book, per account and on this machine alone. Twitch closed its own Friends
 * feature on 25 May 2022: there is no list to read, none to sync, and nothing anyone can
 * withdraw a second time. A contact here grants nothing on Twitch either — someone who blocks
 * whispers from strangers still refuses them, added or not.
 */
export class ContactStore {
  constructor(private readonly database: DatabaseSync) {}

  /** By login: the only order the store can know. What the address book shows, it sorts itself. */
  list(scope: string): Contact[] {
    const rows = this.database.prepare('SELECT login, user_id, display_name, note, added_at FROM contacts WHERE scope = ? ORDER BY login')
      .all(scope) as unknown as ContactRow[]
    return rows.map(rowToContact)
  }

  /**
   * Adds someone, or refreshes what Twitch says about them. Returns false when they were
   * already there: adding twice must never cost the note, nor move the date they were added.
   */
  add(scope: string, contact: { login: string; userId?: string; displayName?: string }, at = Date.now()): boolean {
    const login = channelName(contact.login)
    const userId = /^\d{1,30}$/.test(contact.userId ?? '') ? contact.userId! : ''
    const displayName = (contact.displayName || login).slice(0, 60)
    this.database.exec('BEGIN IMMEDIATE')
    try {
      // An account whose preferences were never saved has no row yet: it is opened rather than
      // the contact refused. Same hand as the channel activity and the whispers.
      this.database.prepare('INSERT INTO scopes (scope, updated_at) VALUES (?, ?) ON CONFLICT(scope) DO NOTHING').run(scope, at)
      // An upsert reports one row changed either way: only a look beforehand tells the new
      // contact from the one whose display name Twitch has simply refreshed.
      const known = this.database.prepare('SELECT login FROM contacts WHERE scope = ? AND login = ?').get(scope, login)
      this.database.prepare(`INSERT INTO contacts (scope, login, user_id, display_name, note, added_at)
        VALUES (?, ?, ?, ?, '', ?)
        ON CONFLICT(scope, login) DO UPDATE SET
          user_id = CASE WHEN excluded.user_id = '' THEN contacts.user_id ELSE excluded.user_id END,
          display_name = excluded.display_name`)
        .run(scope, login, userId, displayName, at)
      this.database.exec('COMMIT')
      return !known
    } catch (error) { this.database.exec('ROLLBACK'); throw error }
  }

  /** What was written about someone. Empty clears it; the contact stays. */
  note(scope: string, login: string, note: string): void {
    this.database.prepare('UPDATE contacts SET note = ? WHERE scope = ? AND login = ?')
      .run(note.slice(0, 500), scope, channelName(login))
  }

  /**
   * Off the address book. What was said with them is not touched: forgetting someone and
   * erasing a correspondence are two different intentions, and the second has its own door.
   */
  remove(scope: string, login: string): void {
    this.database.prepare('DELETE FROM contacts WHERE scope = ? AND login = ?').run(scope, channelName(login))
  }
}
