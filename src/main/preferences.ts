import { readFile, rename } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { channelName, DEFAULT_IDLE_HOURS, languageChoice, layoutPreferences, notificationPreferences, playbackPreferences, playerWindowBounds, QUALITIES, qualityName, themeName, windowBounds } from '../shared/validation'
import type { Preferences } from '../shared/types'
import { ANONYMOUS_SCOPE, openDatabase } from './database'
import { fail } from '../shared/errors'

export { ANONYMOUS_SCOPE } from './database'

export const defaultPreferences: Preferences = {
  channels: [], active: '', quality: '480p,best', theme: 'system', language: '',
  layout: { playerWidth: 0, sidebarCollapsed: false, hideIdleChannels: true, idleChannelHours: DEFAULT_IDLE_HOURS },
  playback: { buffer: 'balanced', autoplay: true, detached: false, volume: 1, muted: false }, notifications: { mentions: true }
}

export function validatePreferences(input: unknown): Preferences {
  if (!input || typeof input !== 'object') fail('preferencesInvalid')
  const value = input as Record<string, unknown>
  if (!Array.isArray(value.channels) || value.channels.length > 20) fail('channelLimit')
  const channels = [...new Set(value.channels.map(channelName))]
  const active = value.active === '' ? '' : channelName(value.active)
  const bounds = windowBounds(value.window)
  const playerBounds = playerWindowBounds(value.playerWindow)
  return {
    channels, active: channels.includes(active) ? active : channels[0] ?? '',
    quality: qualityName(value.quality), theme: themeName(value.theme), language: languageChoice(value.language), layout: layoutPreferences(value.layout),
    playback: playbackPreferences(value.playback), notifications: notificationPreferences(value.notifications),
    ...(bounds ? { window: bounds } : {}),
    ...(playerBounds ? { playerWindow: playerBounds } : {})
  }
}

/** A scope name: a Twitch login, or the key for sessions without an account. */
export function scopeName(login: string | null): string {
  return login ? channelName(login) : ANONYMOUS_SCOPE
}

interface ScopeRow {
  active: string; quality: string; theme: string; language: string
  player_width: number; sidebar_collapsed: number
  buffer: string; autoplay: number; notify_mentions: number; video_detached: number
  window_width: number | null; window_height: number | null
  window_x: number | null; window_y: number | null; window_maximized: number
  player_window_width: number | null; player_window_height: number | null
  player_window_x: number | null; player_window_y: number | null; player_window_pinned: number
  volume: number; muted: number
  hide_idle: number; idle_hours: number
}

const bool = (value: number) => value !== 0
const flag = (value: boolean) => value ? 1 : 0

/**
 * The database is the only judge of what was written; the values still come back out
 * through the validator, so the same fallback rule serves both the file and the columns.
 * `quality` is bounded beforehand because it alone throws: a damaged column there would
 * cost the account its list of rooms.
 */
function rowToPreferences(row: ScopeRow, channels: string[]): Preferences {
  const window = row.window_width !== null && row.window_height !== null
    ? { width: row.window_width, height: row.window_height, x: row.window_x ?? undefined, y: row.window_y ?? undefined, maximized: bool(row.window_maximized) }
    : undefined
  // The player window never maximizes from preferences: only its size and position are restored.
  const playerWindow = row.player_window_width !== null && row.player_window_height !== null
    ? { width: row.player_window_width, height: row.player_window_height, x: row.player_window_x ?? undefined, y: row.player_window_y ?? undefined, maximized: false, pinned: bool(row.player_window_pinned) }
    : undefined
  return validatePreferences({
    channels, active: row.active,
    quality: (QUALITIES as readonly string[]).includes(row.quality) ? row.quality : defaultPreferences.quality,
    theme: row.theme, language: row.language,
    layout: {
      playerWidth: row.player_width, sidebarCollapsed: bool(row.sidebar_collapsed),
      hideIdleChannels: bool(row.hide_idle), idleChannelHours: row.idle_hours
    },
    playback: { buffer: row.buffer, autoplay: bool(row.autoplay), detached: bool(row.video_detached), volume: row.volume / 100, muted: bool(row.muted) },
    notifications: { mentions: bool(row.notify_mentions) },
    ...(window ? { window } : {}),
    ...(playerWindow ? { playerWindow } : {})
  })
}

/**
 * Preferences, with per-account scoping. Each scope has its own row and its own rooms;
 * nothing an account sets is visible from another one.
 *
 * Writes stay queued as they were back when this was a file: SQLite makes each
 * transaction atomic, but two writers — the window saving its geometry, the renderer
 * saving its rooms — would otherwise read the same state before rewriting it.
 */
export class PreferencesStore {
  private readonly database: DatabaseSync
  private writing: Promise<unknown> = Promise.resolve()

  constructor(path: string) { this.database = openDatabase(path) }

  private read(scope: string): Preferences {
    const row = this.database.prepare('SELECT * FROM scopes WHERE scope = ?').get(scope) as ScopeRow | undefined
    if (!row) return { ...defaultPreferences, channels: [] }
    const channels = (this.database.prepare('SELECT channel FROM scope_channels WHERE scope = ? ORDER BY position').all(scope) as { channel: string }[])
      .map(entry => entry.channel)
    try { return rowToPreferences(row, channels) }
    catch { return { ...defaultPreferences, channels: [] } }
  }

  private writeRow(scope: string, preferences: Preferences) {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.database.prepare(`INSERT INTO scopes (
          scope, active, quality, theme, language, player_width, sidebar_collapsed, buffer, autoplay, notify_mentions,
          window_width, window_height, window_x, window_y, window_maximized,
          player_window_width, player_window_height, player_window_x, player_window_y, player_window_pinned, volume, muted, video_detached,
          hide_idle, idle_hours, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope) DO UPDATE SET
          active = excluded.active, quality = excluded.quality, theme = excluded.theme, language = excluded.language,
          player_width = excluded.player_width, sidebar_collapsed = excluded.sidebar_collapsed,
          buffer = excluded.buffer, autoplay = excluded.autoplay, notify_mentions = excluded.notify_mentions,
          window_width = excluded.window_width, window_height = excluded.window_height,
          window_x = excluded.window_x, window_y = excluded.window_y, window_maximized = excluded.window_maximized,
          player_window_width = excluded.player_window_width, player_window_height = excluded.player_window_height,
          player_window_x = excluded.player_window_x, player_window_y = excluded.player_window_y,
          player_window_pinned = excluded.player_window_pinned,
          volume = excluded.volume, muted = excluded.muted, video_detached = excluded.video_detached,
          hide_idle = excluded.hide_idle, idle_hours = excluded.idle_hours,
          updated_at = excluded.updated_at`).run(
        scope, preferences.active, preferences.quality, preferences.theme, preferences.language,
        preferences.layout.playerWidth, flag(preferences.layout.sidebarCollapsed),
        preferences.playback.buffer, flag(preferences.playback.autoplay), flag(preferences.notifications.mentions),
        preferences.window?.width ?? null, preferences.window?.height ?? null,
        preferences.window?.x ?? null, preferences.window?.y ?? null, flag(preferences.window?.maximized ?? false),
        preferences.playerWindow?.width ?? null, preferences.playerWindow?.height ?? null,
        preferences.playerWindow?.x ?? null, preferences.playerWindow?.y ?? null, flag(preferences.playerWindow?.pinned ?? false),
        Math.round(preferences.playback.volume * 100), flag(preferences.playback.muted), flag(preferences.playback.detached),
        flag(preferences.layout.hideIdleChannels), preferences.layout.idleChannelHours,
        Date.now()
      )
      // Rewrite the whole list: the order of the rooms is part of the preference.
      this.database.prepare('DELETE FROM scope_channels WHERE scope = ?').run(scope)
      const insert = this.database.prepare('INSERT INTO scope_channels (scope, position, channel) VALUES (?, ?, ?)')
      preferences.channels.forEach((channel, position) => { insert.run(scope, position, channel) })
      this.database.exec('COMMIT')
    } catch (error) { this.database.exec('ROLLBACK'); throw error }
  }

  async load(scope: string): Promise<Preferences> {
    await this.settled()
    return this.read(scope)
  }

  /**
   * Read, mutate, then write inside the queue: the window writes its geometry while
   * the renderer saves its rooms, without one erasing the other.
   */
  patch(scope: string, mutate: (current: Preferences) => Preferences): Promise<Preferences> {
    const next = this.settled().then(() => {
      const preferences = validatePreferences(mutate(this.read(scope)))
      this.writeRow(scope, preferences)
      return preferences
    })
    this.writing = next
    return next
  }

  /**
   * The last activity of each of the account's rooms. It lives outside the preferences:
   * every save rewrites `scope_channels` whole, so a date kept there would not survive.
   */
  channelActivity(scope: string): Record<string, number> {
    const rows = this.database.prepare('SELECT channel, last_active_at FROM channel_activity WHERE scope = ?')
      .all(scope) as { channel: string; last_active_at: number }[]
    return Object.fromEntries(rows.map(row => [row.channel, row.last_active_at]))
  }

  /**
   * Redates rooms that have just come alive. The account row is created when missing: the
   * foreign key would otherwise refuse a room that stirs before the first save.
   */
  markChannelActivity(scope: string, channels: string[], at = Date.now()): void {
    if (!channels.length) return
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.database.prepare('INSERT INTO scopes (scope, updated_at) VALUES (?, ?) ON CONFLICT(scope) DO NOTHING').run(scope, at)
      const mark = this.database.prepare(`INSERT INTO channel_activity (scope, channel, last_active_at) VALUES (?, ?, ?)
        ON CONFLICT(scope, channel) DO UPDATE SET last_active_at = excluded.last_active_at`)
      for (const channel of channels) mark.run(scope, channelName(channel), at)
      this.database.exec('COMMIT')
    } catch (error) { this.database.exec('ROLLBACK'); throw error }
  }

  /** The accounts that have already set something on this device. */
  scopes(): string[] {
    return (this.database.prepare('SELECT scope FROM scopes ORDER BY updated_at DESC').all() as { scope: string }[]).map(row => row.scope)
  }

  /**
   * The last active scope. It serves at startup, before an account is chosen: the
   * window and the theme of the session gate are those of the last session.
   */
  lastScope(): string | null {
    const row = this.database.prepare(`SELECT value FROM app WHERE key = 'lastScope'`).get() as { value: string } | undefined
    return row?.value ?? null
  }

  rememberScope(scope: string): void {
    this.database.prepare(`INSERT INTO app (key, value) VALUES ('lastScope', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(scope)
  }

  /**
   * Erases everything an account has set — rooms and channel activity go with it, through the
   * cascade. The last-scope pointer goes too when it names this one: left behind, the next launch
   * would load a scope that no longer exists and quietly build it again, so an account the user
   * asked to be forgotten would come back as an empty one.
   */
  forget(scope: string): void {
    this.database.prepare('DELETE FROM scopes WHERE scope = ?').run(scope)
    this.database.prepare(`DELETE FROM app WHERE key = 'lastScope' AND value = ?`).run(scope)
  }

  /**
   * Takes over the previous version's `preferences.json`, which knew nothing of accounts,
   * into the given scope. The file is renamed rather than deleted: the import stays
   * verifiable, and a fresh database will not re-import it into the wrong account.
   */
  async importLegacyFile(path: string, scope: string): Promise<Preferences | null> {
    if (this.scopes().length) return null
    let legacy: Preferences
    try { legacy = validatePreferences(JSON.parse(await readFile(path, 'utf8'))) }
    catch { return null }
    const imported = await this.patch(scope, () => legacy)
    // The imported account becomes the last active one: the first startup after the import
    // finds its rooms and its window again, instead of opening on an empty scope.
    this.rememberScope(scope)
    await rename(path, `${path}.migrated`).catch(() => {})
    return imported
  }

  /** Waits for pending writes to finish: closing the application does not cut the last one short. */
  settled(): Promise<void> { return this.writing.then(() => {}, () => {}) }

  close(): void { this.database.close() }
}
