import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { errorKey } from '../src/shared/errors'
import { pickVariant, StreamResolver, streamVariants } from '../src/main/streams'

/** Two master playlists as Twitch served them, with the addresses and the viewer's own stripped. */
async function fixture(channel: string) {
  return readFile(join(import.meta.dirname, 'fixtures', `master-${channel}.m3u8`), 'utf8')
}

/** Everything the resolver needs of the network, answered from here. */
function twitch({ playlist, claims = {}, usherStatus = 200 }: { playlist: string; claims?: Record<string, unknown>; usherStatus?: number }) {
  const calls: string[] = []
  const fetch = async (url: string) => {
    calls.push(url)
    if (url.startsWith('https://gql.twitch.tv/')) {
      const value = JSON.stringify({ channel: 'alice', ...claims })
      return Response.json({ data: { streamPlaybackAccessToken: { value, signature: 'signature' } } })
    }
    return usherStatus === 200 ? new Response(playlist) : new Response('[{"error":"Can not find channel"}]', { status: usherStatus })
  }
  return { calls, resolver: new StreamResolver(fetch) }
}

test('reads the variants a master playlist offers, whatever it calls them', async () => {
  const variants = streamVariants(await fixture('anyme023'))
  assert.equal(variants.length, 6)
  // Measured, not named: the source is labelled `1080p50 (source)` in a group named `chunked`.
  assert.deepEqual(variants.map(variant => variant.height), [1080, 720, 480, 360, 160, 0])
  assert.equal(variants[0].group, 'chunked')
  assert.equal(variants[0].bandwidth, 7921344)
  // The audio-only rendition announces no resolution at all: that is what names it.
  assert.equal(variants.at(-1)?.group, 'audio_only')
  assert.match(variants[0].url, /^https:\/\/[\w.-]+\.ttvnw\.net\//)
})

test('every quality the window offers resolves on a real playlist', async () => {
  for (const channel of ['anyme023', 'zerator']) {
    const variants = streamVariants(await fixture(channel))
    const height = (quality: string) => pickVariant(variants, quality)?.height
    assert.equal(height('360p,worst'), 360, channel)
    assert.equal(height('480p,best'), 480, channel)
    // Twitch labels a fifty-image stream `720p60`; refusing it on that would serve nothing.
    assert.equal(height('720p60,720p,best'), 720, channel)
    assert.equal(height('best'), 1080, channel)
    assert.equal(height('audio_only'), 0, channel)
  }
})

test('a channel that transcodes nothing still plays', () => {
  // Small channels are served their source and nothing else: every preference falls back to it.
  const source = streamVariants([
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="chunked",NAME="900p60 (source)",AUTOSELECT=YES,DEFAULT=YES',
    '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1600x900,CODECS="avc1.64002A",VIDEO="chunked",FRAME-RATE=60.000',
    'https://euw31.playlist.ttvnw.net/v1/playlist/chunked.m3u8'
  ].join('\n'))
  for (const quality of ['360p,worst', '480p,best', '720p60,720p,best', 'best']) {
    assert.equal(pickVariant(source, quality)?.height, 900, quality)
  }
  // Asked for audio, served the lightest thing there is — never the source by surprise.
  assert.equal(pickVariant(source, 'audio_only')?.height, 900)
})

test('the frame rate only breaks a tie between two variants of one height', () => {
  const variants = streamVariants([
    '#EXT-X-STREAM-INF:BANDWIDTH=3400000,RESOLUTION=1280x720,VIDEO="720p60",FRAME-RATE=60.000',
    'https://euw31.playlist.ttvnw.net/v1/playlist/720p60.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,VIDEO="720p30",FRAME-RATE=30.000',
    'https://euw31.playlist.ttvnw.net/v1/playlist/720p30.m3u8'
  ].join('\n'))
  assert.equal(pickVariant(variants, '720p60,720p,best')?.group, '720p60')
})

test('resolves a channel to a playable address behind the media protocol', async () => {
  const context = twitch({ playlist: await fixture('zerator') })
  const url = await context.resolver.resolve('ZeratoR', '480p,best')

  assert.match(url, /^twitch-media:\/\/[\w.-]+\.ttvnw\.net\//)
  assert.equal(context.calls.length, 2)
  // The channel travels in the token request, and the playlist is asked for by name.
  assert.match(context.calls[0], /^https:\/\/gql\.twitch\.tv\/gql$/)
  assert.match(context.calls[1], /^https:\/\/usher\.ttvnw\.net\/api\/channel\/hls\/zerator\.m3u8\?/)
})

test('two playbacks never carry the same session identifier', async () => {
  const context = twitch({ playlist: await fixture('zerator') })
  await context.resolver.resolve('zerator', 'best')
  await context.resolver.resolve('zerator', 'best')

  const sessions = context.calls.filter(url => url.includes('usher')).map(url => new URL(url).searchParams.get('play_session_id'))
  assert.equal(sessions.length, 2)
  assert.notEqual(sessions[0], sessions[1])
  assert.match(String(sessions[0]), /^[0-9a-f]{32}$/)
})

test('a channel that is not live is named as such, not as a failure', async () => {
  const context = twitch({ playlist: '', usherStatus: 404 })
  await assert.rejects(context.resolver.resolve('nobody', 'best'), error => errorKey(error) === 'channelOffline')
})

test('a stream nobody here may watch says which of the two it is', async () => {
  const reserved = twitch({ playlist: '', claims: { authorization: { forbidden: true, reason: 'subscribers only' } } })
  await assert.rejects(reserved.resolver.resolve('alice', 'best'), error => errorKey(error) === 'streamRestricted')
  // The playlist is never asked for: the token already answered.
  assert.equal(reserved.calls.length, 1)

  const elsewhere = twitch({ playlist: '', claims: { geoblock_reason: 'unavailable in your region' } })
  await assert.rejects(elsewhere.resolver.resolve('alice', 'best'), error => errorKey(error) === 'streamGeoblocked')
})

test('a playback replaced by another is cancelled, not answered late', async () => {
  const context = twitch({ playlist: await fixture('zerator') })
  const abandoned = context.resolver.resolve('zerator', 'best')
  context.resolver.stop()
  await assert.rejects(abandoned, error => errorKey(error) === 'streamCancelled')
})
