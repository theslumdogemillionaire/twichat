import type { BufferMode } from '../shared/types'
import { errorKey } from '../shared/errors'

export type StreamPlayerState = 'loading' | 'playing' | 'offline' | 'reconnecting' | 'stopped' | 'error'

export interface StreamRetryPlan {
  retry: boolean
  state: 'offline' | 'reconnecting' | 'error'
  delay: number
}

export const STREAM_STALL_TIMEOUT = 18_000

/**
 * The retry decides on the error key, never on its sentence: translating a message must
 * not change the player's behavior. A stream nobody here may watch — reserved, or not served
 * in this country — is not retried: waiting changes none of the two.
 */
export function streamRetryPlan(reason: unknown, attempt: number): StreamRetryPlan {
  const key = errorKey(reason)
  // A refused query answers the same on every channel and on every attempt: retrying it only
  // buries the one message that says what to do about it.
  if (key === 'hlsUnsupported' || key === 'streamRestricted' || key === 'streamGeoblocked' || key === 'streamQueryRejected') return { retry: false, state: 'error', delay: 0 }
  if (key === 'channelOffline' || key === 'streamEnded') return { retry: true, state: 'offline', delay: 15_000 }
  return { retry: true, state: 'reconnecting', delay: Math.min(30_000, 3_000 * 2 ** Math.min(3, Math.max(0, attempt))) }
}

/** hls.js quantises its catch-up to steps of .05 and clamps at 1: anything above this is a real catch-up. */
export const CATCH_UP_RATE = 1.02

/**
 * The symbol shows the moment the rate goes up; the link under it waits. A catch-up shorter than
 * this settles by itself, and pointing at a setting for it would send the viewer after a non-problem.
 */
export const CATCH_UP_CUE_DELAY = 2_000

/** Catch-ups over one stream, past which the delay is the buffer being too small, not a hiccup. */
export const CATCH_UP_HINT_RUNS = 3

/** Whether this catch-up is one of a series: the link then comes with the symbol, without the wait. */
export function isRecurringCatchUp(runs: number): boolean { return runs >= CATCH_UP_HINT_RUNS }

/**
 * hls.js raises video.playbackRate up to maxLiveSyncPlaybackRate once the delay passes
 * liveMaxLatencyDuration, then drops it back to 1. That rate is the whole signal: while it is up,
 * the picture says so; back on pace, it says nothing at all.
 */
export function isCatchingUp(rate: number): boolean { return rate >= CATCH_UP_RATE }


/** What the buffering mode changes in hls.js. The seconds are the ones the viewer sees. */
export interface BufferProfile {
  /** Segments kept behind the playhead, in seconds. */
  backBufferLength: number
  /** Target lead, then tolerated lead, in seconds. */
  maxBufferLength: number
  maxMaxBufferLength: number
  /** Ceiling in bytes: at a high bitrate this is what bounds the lead, not the seconds. */
  maxBufferSize: number
  /** Target delay behind the live stream, then the delay past which the player catches up. */
  liveSyncDuration: number
  liveMaxLatencyDuration: number
}

const megabytes = (count: number) => count * 1024 * 1024

/**
 * Twitch announces TARGETDURATION:6 for 2 s segments: the
 * liveSyncDurationCount/liveMaxLatencyDurationCount variants multiply by that value, hence
 * targets expressed in seconds. `balanced` reuses exactly the player's original
 * values: a silent preferences file therefore changes nothing about playback.
 */
export const BUFFER_PROFILES: Record<BufferMode, BufferProfile> = {
  live: { backBufferLength: 4, maxBufferLength: 6, maxMaxBufferLength: 12, maxBufferSize: megabytes(12), liveSyncDuration: 2, liveMaxLatencyDuration: 6 },
  balanced: { backBufferLength: 10, maxBufferLength: 12, maxMaxBufferLength: 24, maxBufferSize: megabytes(24), liveSyncDuration: 3, liveMaxLatencyDuration: 10 },
  comfort: { backBufferLength: 20, maxBufferLength: 30, maxMaxBufferLength: 60, maxBufferSize: megabytes(60), liveSyncDuration: 6, liveMaxLatencyDuration: 18 }
}

export function bufferProfile(mode: BufferMode): BufferProfile { return BUFFER_PROFILES[mode] }

/** Where a picture stands when a room is opened: the channel it plays, and what that room is. */
export interface HeldStream {
  /** The room concerned — the one being opened, or the one already open. */
  room: string
  /** The channel the picture is on, empty when nothing plays. */
  held: string
  /** Whether that channel is on screen. A player retrying an offline stream shows nothing. */
  picture: boolean
  /** What Twitch says of the room, `undefined` for as long as it has said nothing. */
  roomLive: boolean | undefined
}

/**
 * What a video on screen does about the room being opened. A room off air has no picture of its
 * own to put there, and cutting the one playing to show it "the live stream is over" takes away
 * the stream the viewer was watching for nothing: it stays where it is, the way the directory and
 * the settings float over it rather than closing it. The moment that room goes on air it is the
 * one being read, and the picture follows. Anything else is the ordinary course: nothing on
 * screen, a picture already on this room, or a channel Twitch has not answered for yet — which is
 * the state of a channel just joined, and there the video starts as it always has.
 */
export function heldStreamChoice({ room, held, picture, roomLive }: HeldStream): 'keep' | 'follow' | 'release' {
  if (!room || !held || held === room || roomLive === undefined) return 'release'
  if (roomLive) return 'follow'
  // Only a picture is worth keeping. A player working through its offline retries has none, and
  // holding on to it would cost the room opened its own — the retries are how a channel coming
  // back on air is noticed, and the placeholder promises exactly that.
  return picture ? 'keep' : 'release'
}
