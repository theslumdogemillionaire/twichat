import { randomBytes } from 'node:crypto'
import { channelName, mediaUrl, qualityName } from '../shared/validation'
import { AppError, fail } from '../shared/errors'

type Fetch = (url: string, init?: RequestInit) => Promise<Response>

/**
 * The identifier Twitch's own web player travels with. It is public — the site's JavaScript
 * sends it on every request — and it names the player, not a viewer.
 */
const WEB_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko'
/**
 * The query that asks for a playback token, written out rather than named by a hash.
 *
 * The web player sends this operation as a persisted query — a sha256 of the text, registered
 * server-side — and that hash is rotated whenever Twitch ships their client, without notice.
 * One such rotation answers `PersistedQueryNotFound` to every channel at once, and it answers
 * it with an HTTP 200, so nothing on the status line says anything is wrong. Sending the text
 * asks for the same operation with nothing to rotate.
 *
 * This is still the fragile part of the file: what can now break is the query itself — a field
 * renamed, or a different shape expected under `params`. A playback that finds no token on every
 * channel at once points here first, and `streamQueryRejected` is what says so.
 */
const PLAYBACK_ACCESS_TOKEN_QUERY = `query PlaybackAccessToken($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!) {
  streamPlaybackAccessToken(channelName: $login, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) { value signature }
  videoPlaybackAccessToken(id: $vodID, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) { value signature }
}`
const GQL_ENDPOINT = 'https://gql.twitch.tv/gql'
const TIMEOUT = 15_000

export interface StreamVariant { group: string; height: number; frameRate: number; bandwidth: number; url: string }

/** One attribute of an `#EXT-X-` line, quoted or bare. */
function attribute(attributes: string, name: string) {
  const match = new RegExp(`(?:^|,)${name}=("[^"]*"|[^,]*)`).exec(attributes)
  return match ? match[1].replace(/^"|"$/g, '') : ''
}

/**
 * The variants a master playlist offers.
 *
 * Only `#EXT-X-STREAM-INF` and the address on the line after it are read. The labels Twitch
 * writes drift — a stream named `1080p50 (source)` sits in a group named `chunked`, a group
 * named `720p60` carries one at fifty images — while the resolution and the bandwidth are
 * measured rather than named, and say the same thing in every playlist.
 */
export function streamVariants(playlist: string): StreamVariant[] {
  const lines = playlist.split('\n').map(line => line.trim())
  const variants: StreamVariant[] = []
  for (const [index, line] of lines.entries()) {
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue
    const address = lines.slice(index + 1).find(next => next && !next.startsWith('#'))
    if (!address) continue
    const attributes = line.slice(line.indexOf(':') + 1)
    variants.push({
      group: attribute(attributes, 'VIDEO'),
      // An audio-only rendition announces no resolution: a height of zero is what names it.
      height: Number(/^\d+x(\d+)$/.exec(attribute(attributes, 'RESOLUTION'))?.[1] ?? 0),
      frameRate: Number(attribute(attributes, 'FRAME-RATE')) || 0,
      bandwidth: Number(attribute(attributes, 'BANDWIDTH')) || 0,
      url: address
    })
  }
  return variants
}

/**
 * The variant a preference asks for. A preference is a fallback list — `720p60,720p,best` —
 * read left to right, so a channel that transcodes nothing still plays. The height is what is
 * matched; the frame rate only breaks a tie between two variants of the same height, because
 * Twitch labels a fifty-image stream `720p60` and refusing it over that would serve nothing.
 * A list nothing satisfies falls to the lightest variant rather than the heaviest: a viewer who
 * asked for audio or for 360p must not be handed the source stream.
 */
export function pickVariant(variants: StreamVariant[], quality: string): StreamVariant | undefined {
  const video = variants.filter(variant => variant.height > 0).sort((a, b) => a.bandwidth - b.bandwidth)
  for (const token of quality.split(',')) {
    if (token === 'audio_only') {
      const audio = variants.find(variant => variant.height === 0)
      if (audio) return audio
      continue
    }
    if (token === 'best' && video.at(-1)) return video.at(-1)
    if (token === 'worst' && video[0]) return video[0]
    const height = Number(/^(\d+)p/.exec(token)?.[1] ?? 0)
    const matched = video.filter(variant => variant.height === height).sort((a, b) => b.frameRate - a.frameRate || b.bandwidth - a.bandwidth)
    if (matched[0]) return matched[0]
  }
  return video[0] ?? variants[0]
}

/**
 * A media playlist with the advertising Twitch stitched into it taken out.
 *
 * There is no separate address to refuse: the ads are spliced into the same variant as the
 * stream, server-side. What Twitch does leave is a name. A `twitch-stream-source` range announces
 * what is playing, and every segment carries that same string, byte for byte, as its `#EXTINF`
 * title — `live` for the channel, `Amazon|<identifier>` for what was stitched over it. Reading
 * that pairing rather than the word `live` is what lets a rerun or a premiere, whose source is
 * not `live` either, play untouched as long as nothing was stitched into it.
 *
 * **A window holding nothing but advertising is handed back whole.** Dropping every segment
 * leaves an empty playlist, which hls.js reads as a broken level rather than as a pause — and a
 * pre-roll is exactly that case, so the guard is what keeps thirty seconds of advertising from
 * becoming a dead player. Mid-rolls, and the end of a pre-roll once the channel reappears in the
 * window, are filtered.
 */
export function withoutAds(playlist: string): string {
  // The tag that says there is anything to look for. On an ordinary poll — every two seconds, for
  // as long as the stream plays — this test is the whole cost of the feature.
  if (!playlist.includes('twitch-stitched-ad')) return playlist
  const stitched = new Set([...playlist.matchAll(/X-TV-TWITCH-STREAM-SOURCE="([^"]*)"/g)].map(match => match[1]).filter(source => source !== 'live'))
  if (!stitched.size) return playlist

  const kept: string[] = []
  // Tags describing the segment that has not arrived yet: they leave with it if it goes.
  let pending: string[] = []
  let keptSegment = false
  let dropped = 0
  /** Segments dropped ahead of the first one kept: what `#EXT-X-MEDIA-SEQUENCE` has to move by. */
  let leading = 0
  for (const line of playlist.split('\n')) {
    const tag = line.trim()
    // Ranges that describe what is being removed: the ad itself, and its viewing quartiles.
    if (tag.startsWith('#EXT-X-DATERANGE:') && /CLASS="twitch-(?:stitched-ad|ad-quartile)"/.test(tag)) continue
    if (tag.startsWith('#EXTINF:') || tag.startsWith('#EXT-X-DISCONTINUITY') || tag.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) { pending.push(line); continue }
    if (!tag || tag.startsWith('#')) { (pending.length ? pending : kept).push(line); continue }
    // Anything else is a segment address, and what piled up before it belongs to it.
    const title = pending.map(entry => /^#EXTINF:[\d.]*,(.*)$/.exec(entry.trim())?.[1]).find(found => found !== undefined)?.trim() ?? ''
    if (stitched.has(title)) { dropped++; if (!keptSegment) leading++ }
    else { keptSegment = true; kept.push(...pending, line) }
    pending = []
  }
  // Nothing to do, or nothing left to play: the playlist goes back as Twitch wrote it.
  if (!dropped || !keptSegment) return playlist
  kept.push(...pending)
  const result = kept.join('\n')
  // The sequence number names the first segment in the playlist. Dropping segments ahead of it
  // moves it, and a number left behind makes the player take live segments for ones it has.
  return leading ? result.replace(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/m, (_, value: string) => `#EXT-X-MEDIA-SEQUENCE:${Number(value) + leading}`) : result
}

/**
 * Resolves the public HLS playlist of a live channel, the way the Twitch player itself does:
 * a playback token, then the master playlist, then the variant the viewer asked for. What
 * plays it is hls.js in the window — this only ever hands it an address.
 */
export class StreamResolver {
  private controller?: AbortController
  private generation = 0
  /**
   * `accountToken` is read at each playback rather than held, so signing in or out is picked up
   * without rebuilding the resolver. Twitch decides what to serve from who is asking: a viewer it
   * cannot identify is the one it shows the most advertising to, and a subscription or a Turbo on
   * the connected account counts for nothing unless the request carries it.
   */
  constructor(private readonly fetch: Fetch = globalThis.fetch, private readonly accountToken: () => string | null = () => null) {}

  stop() {
    this.generation++
    this.controller?.abort()
    this.controller = undefined
  }

  async resolve(room: string, requestedQuality: string): Promise<string> {
    const channel = channelName(room)
    const quality = qualityName(requestedQuality)
    // A room left behind must not keep a request alive, nor answer over the room now shown.
    this.stop()
    const generation = this.generation
    const controller = new AbortController()
    this.controller = controller
    const timeout = setTimeout(() => controller.abort(), TIMEOUT)
    try {
      const access = await this.playbackToken(channel, controller.signal)
      if (generation !== this.generation) fail('streamCancelled')
      const playlist = await this.masterPlaylist(channel, access, controller.signal)
      if (generation !== this.generation) fail('streamCancelled')
      const variant = pickVariant(streamVariants(playlist), quality)
      if (!variant) fail('streamUnreadable')
      let address: URL
      try { address = mediaUrl(variant.url) }
      catch { throw new AppError('streamResolverInvalid') }
      return address.href.replace(/^https:/, 'twitch-media:')
    } catch (error) {
      if (error instanceof AppError) throw error
      // What is left is an abort: this playback being replaced, or the timeout above.
      throw new AppError(generation !== this.generation ? 'streamCancelled' : 'streamUnreadable')
    } finally {
      clearTimeout(timeout)
      if (this.controller === controller) this.controller = undefined
    }
  }

  private async playbackToken(channel: string, signal: AbortSignal) {
    // Asked for as the account first. Our token was issued to this application's own client, not
    // to the web player named in the header, and Twitch is within its rights to refuse the pair:
    // a second attempt without it then gets the same public playlist as before, so signing in can
    // only ever add to what plays, never take it away.
    const account = this.accountToken()
    let attempt = await this.requestPlaybackToken(channel, account, signal)
    if (!attempt.token && account) attempt = await this.requestPlaybackToken(channel, null, signal)
    // A GraphQL error on an attempt carrying no account is not about who is asking: it is the
    // query above being refused, on this channel and on every other. Naming it keeps a rotated
    // schema from spending the evening looking like a stream Twitch merely failed to serve.
    if (!attempt.token && attempt.rejected) fail('streamQueryRejected')
    const token = attempt.token
    // A query answered without complaint, and with no token in it, is Twitch saying it has no
    // stream under that name — the same thing usher's 404 below says, and named the same way.
    if (!token) fail('channelOffline')
    // The token says what the playlist would only answer with a bare 403: a stream kept for
    // subscribers, or one this country is not served.
    let claims: Record<string, unknown> = {}
    try { claims = JSON.parse(token.value) as Record<string, unknown> } catch { /* A shape we do not know; the playlist below still decides. */ }
    if ((claims.authorization as { forbidden?: unknown } | undefined)?.forbidden === true) fail('streamRestricted')
    if (typeof claims.geoblock_reason === 'string' && claims.geoblock_reason) fail('streamGeoblocked')
    return { value: token.value, signature: token.signature }
  }

  private async requestPlaybackToken(channel: string, account: string | null, signal: AbortSignal) {
    const response = await this.fetch(GQL_ENDPOINT, {
      method: 'POST',
      headers: { 'Client-ID': WEB_CLIENT_ID, 'Content-Type': 'application/json', ...(account ? { Authorization: `OAuth ${account}` } : {}) },
      body: JSON.stringify({
        operationName: 'PlaybackAccessToken',
        // The surface asking for the stream. Twitch stitches a pre-roll into `site` — the page
        // player — and none into `embed`, the one third-party embeds use, which is offered the
        // same renditions down to the source: measured on six channels, `site` carried an ad on
        // all six and `embed` on none, with identical variant lists. It is also the only other
        // type that keeps them: `autoplay` and `thunderdome` are capped at 360p.
        //
        // Nothing here relaxes what Twitch allows. The claims below are read from the token it
        // signs, so a subscriber-only stream and a geoblocked one are refused exactly as before.
        variables: { isLive: true, login: channel, isVod: false, vodID: '', playerType: 'embed' },
        query: PLAYBACK_ACCESS_TOKEN_QUERY
      }),
      signal
    })
    if (!response.ok) return { token: null }
    const body = await response.json().catch(() => ({})) as {
      data?: { streamPlaybackAccessToken?: { value?: unknown; signature?: unknown } }
      errors?: { message?: unknown }[]
    }
    const token = body.data?.streamPlaybackAccessToken
    if (typeof token?.value === 'string' && typeof token.signature === 'string') {
      return { token: { value: token.value, signature: token.signature } }
    }
    // GraphQL reports a refused query inside a 200, so the status line above sees nothing. Said
    // once here, the reason is in the log rather than only in the shape of what did not arrive.
    const rejected = body.errors?.length ? String(body.errors[0]?.message ?? 'unknown error') : null
    if (rejected && !account) console.warn('Twitch refused the playback token query:', rejected)
    return { token: null, rejected: Boolean(rejected) }
  }

  private async masterPlaylist(channel: string, access: { value: string; signature: string }, signal: AbortSignal) {
    const url = new URL(`https://usher.ttvnw.net/api/channel/hls/${channel}.m3u8`)
    url.search = new URLSearchParams({
      allow_source: 'true', allow_audio_only: 'true', fast_bread: 'true',
      // Drawn per playback: a session identifier fixed in the source would follow every
      // viewer of this application around, and identify them to Twitch as one of them.
      p: String(randomBytes(4).readUInt32BE(0) % 10_000_000),
      play_session_id: randomBytes(16).toString('hex'),
      player_backend: 'mediaplayer', playlist_include_framerate: 'true',
      sig: access.signature, supported_codecs: 'avc1', token: access.value, transcode_mode: 'cbr_v1'
    }).toString()
    const response = await this.fetch(url.href, { signal })
    // Usher answers 404 both for a channel that is not live and for one that does not exist.
    if (response.status === 404) fail('channelOffline')
    if (!response.ok) fail('streamUnreadable')
    return response.text()
  }
}
