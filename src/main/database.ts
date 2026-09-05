import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Per-account scoping. A "scope" is one Twitch account, plus the one for sessions
 * without an account: `channelName` forbids `#` in a Twitch identifier, so this
 * key cannot collide with any login, today or later on.
 */
export const ANONYMOUS_SCOPE = '#anonymous'

/** A database a newer version of the application wrote. Told apart so the failure can be named. */
export class DatabaseTooNew extends Error {
  constructor(readonly found: number, readonly known: number) {
    super(`This database is at revision ${found} and this build knows ${known}.`)
    this.name = 'DatabaseTooNew'
  }
}

/**
 * Each revision runs once, in order, and `user_version` remembers where the
 * database stands. A shipped revision is never edited again: another one is added.
 */
const REVISIONS = [
  `CREATE TABLE scopes (
     scope TEXT PRIMARY KEY,
     active TEXT NOT NULL DEFAULT '',
     quality TEXT NOT NULL DEFAULT '480p,best',
     theme TEXT NOT NULL DEFAULT 'system',
     player_width INTEGER NOT NULL DEFAULT 0,
     sidebar_collapsed INTEGER NOT NULL DEFAULT 0,
     buffer TEXT NOT NULL DEFAULT 'balanced',
     autoplay INTEGER NOT NULL DEFAULT 1,
     notify_mentions INTEGER NOT NULL DEFAULT 1,
     window_width INTEGER,
     window_height INTEGER,
     window_x INTEGER,
     window_y INTEGER,
     window_maximized INTEGER NOT NULL DEFAULT 0,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE scope_channels (
     scope TEXT NOT NULL REFERENCES scopes(scope) ON DELETE CASCADE,
     position INTEGER NOT NULL,
     channel TEXT NOT NULL,
     PRIMARY KEY (scope, channel)
   );
   CREATE INDEX scope_channels_order ON scope_channels(scope, position);
   CREATE TABLE app (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  // The interface language joins the account settings; when empty, it follows the system.
  `ALTER TABLE scopes ADD COLUMN language TEXT NOT NULL DEFAULT ''`,
  // The detached player window keeps its geometry, and the player its volume: the native
  // video controls no longer show it, so the application is the one that remembers it.
  `ALTER TABLE scopes ADD COLUMN player_window_width INTEGER;
   ALTER TABLE scopes ADD COLUMN player_window_height INTEGER;
   ALTER TABLE scopes ADD COLUMN player_window_x INTEGER;
   ALTER TABLE scopes ADD COLUMN player_window_y INTEGER;
   ALTER TABLE scopes ADD COLUMN volume INTEGER NOT NULL DEFAULT 100;
   ALTER TABLE scopes ADD COLUMN muted INTEGER NOT NULL DEFAULT 0`,
  // Idling the quiet rooms out of sight: the date of the last activity lives apart
  // from `scope_channels`, which every save of the preferences rewrites in full. The
  // rooms already joined are dated today, or else the first opening after the update
  // would fold the whole list away at once, as if it had been lost.
  `CREATE TABLE channel_activity (
     scope TEXT NOT NULL REFERENCES scopes(scope) ON DELETE CASCADE,
     channel TEXT NOT NULL,
     last_active_at INTEGER NOT NULL,
     PRIMARY KEY (scope, channel)
   );
   INSERT INTO channel_activity (scope, channel, last_active_at)
     SELECT scope, channel, CAST(strftime('%s', 'now') AS INTEGER) * 1000 FROM scope_channels;
   ALTER TABLE scopes ADD COLUMN hide_idle INTEGER NOT NULL DEFAULT 1;
   ALTER TABLE scopes ADD COLUMN idle_days INTEGER NOT NULL DEFAULT 7`,
  // The idle delay drops below the day: the unit stored becomes the hour, and the delay
  // already chosen is carried over as it stands rather than being reset to the default.
  `ALTER TABLE scopes ADD COLUMN idle_hours INTEGER NOT NULL DEFAULT 168;
   UPDATE scopes SET idle_hours = idle_days * 24;
   ALTER TABLE scopes DROP COLUMN idle_days`,
  // Pinned, the video window stays above the others — a choice made once, not at every launch.
  `ALTER TABLE scopes ADD COLUMN player_window_pinned INTEGER NOT NULL DEFAULT 0`,
  // Where the video plays is a choice one makes once: the next launch reopens the window.
  `ALTER TABLE scopes ADD COLUMN video_detached INTEGER NOT NULL DEFAULT 0`
]

/**
 * Opens the database and brings it to the current revision. WAL lets a read on one
 * scope through while another is being written; foreign keys purge the rooms of a
 * deleted scope. `busy_timeout` covers the second instance that has not yet given
 * its lock back, rather than failing on the spot.
 */
export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const database = new DatabaseSync(path)
  database.exec('PRAGMA journal_mode = WAL')
  database.exec('PRAGMA foreign_keys = ON')
  database.exec('PRAGMA busy_timeout = 5000')
  const { user_version: version } = database.prepare('PRAGMA user_version').get() as { user_version: number }
  // A database written by a newer build. The loop below simply would not run, and the application
  // would then read and write a schema it does not know — columns that may have moved, rows the
  // version that wrote them will read back wrong. Downgrading is not supported; saying so and
  // stopping is the only answer that does not damage the data on the way past.
  if (version > REVISIONS.length) {
    database.close()
    throw new DatabaseTooNew(version, REVISIONS.length)
  }
  for (let revision = version; revision < REVISIONS.length; revision++) {
    database.exec('BEGIN IMMEDIATE')
    try {
      database.exec(REVISIONS[revision]!)
      database.exec(`PRAGMA user_version = ${revision + 1}`)
      database.exec('COMMIT')
    } catch (error) { database.exec('ROLLBACK'); throw error }
  }
  return database
}
