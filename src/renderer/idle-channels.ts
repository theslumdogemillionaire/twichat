/**
 * Rooms put to sleep: the ones nothing has stirred for long enough that they clutter the
 * list. Nothing is parted or forgotten — sleeping only touches the display, the stored room
 * list stays whole and IRC stays connected.
 * That is what lets a room come back on its own as soon as something happens in it.
 */

const HOUR = 60 * 60 * 1000

export interface ChannelActivityState {
  channel: string
  live: boolean
  /** Unread messages, mentions included. A room with something to show does not hide. */
  unread: number
  /** The open room: it stays in sight, even after weeks of silence. */
  open: boolean
  /**
   * The last known activity, in milliseconds. Missing, the room stays visible: we never hide
   * on an unknown, whether it comes from the first render, a failed read, or a room joined
   * before sleeping existed.
   */
  lastActive?: number
}

export interface IdleOptions {
  enabled: boolean
  hours: number
  now?: number
}

/** The rooms to put to sleep, in the order they were given. */
export function idleChannels(states: readonly ChannelActivityState[], options: IdleOptions): string[] {
  if (!options.enabled) return []
  const now = options.now ?? Date.now()
  const threshold = Math.max(1, options.hours) * HOUR
  return states.filter(state =>
    !state.live && !state.open && state.unread <= 0 &&
    state.lastActive !== undefined && now - state.lastActive > threshold
  ).map(state => state.channel)
}
