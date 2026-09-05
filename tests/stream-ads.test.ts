import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { withoutAds } from '../src/main/streams'

const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8')
const segments = (playlist: string) => [...playlist.matchAll(/^#EXTINF:[\d.]+,(.*)$/gm)].map(match => match[1].trim())
const sequence = (playlist: string) => Number(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/m.exec(playlist)![1])

/**
 * A window Twitch never hands over in one piece: an ad ending, and the channel coming back inside
 * the same playlist. Both fixtures are pre-rolls — every segment is an ad — so this shape has to
 * be built to check that a partial filter keeps what it should.
 */
function midroll(options: { adsFirst: boolean }) {
  const ad = (index: number) => `#EXT-X-PROGRAM-DATE-TIME:2026-09-05T14:5${index}:00.000Z\n#EXTINF:2.000,Amazon|2474283100494\nhttps://video-edge.example.net/ad-${index}.ts`
  const live = (index: number) => `#EXT-X-PROGRAM-DATE-TIME:2026-09-05T14:5${index}:00.000Z\n#EXTINF:2.000,live\nhttps://video-edge.example.net/live-${index}.ts`
  const blocks = options.adsFirst
    ? ['#EXT-X-DISCONTINUITY', ad(1), ad(2), '#EXT-X-DISCONTINUITY', live(3), live(4)]
    : [live(1), live(2), '#EXT-X-DISCONTINUITY', ad(3), ad(4)]
  return [
    '#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:5', '#EXT-X-MEDIA-SEQUENCE:820',
    '#EXT-X-DATERANGE:ID="stitched-ad-1788620216-30235000000",CLASS="twitch-stitched-ad",START-DATE="2026-09-05T14:56:56.255Z",DURATION=30.235',
    '#EXT-X-DATERANGE:ID="source-1788620216",CLASS="twitch-stream-source",START-DATE="2026-09-05T14:56:56.255Z",END-ON-NEXT=YES,X-TV-TWITCH-STREAM-SOURCE="Amazon|2474283100494"',
    '#EXT-X-DATERANGE:ID="source-1788620246",CLASS="twitch-stream-source",START-DATE="2026-09-05T14:57:26.255Z",END-ON-NEXT=YES,X-TV-TWITCH-STREAM-SOURCE="live"',
    '#EXT-X-DATERANGE:ID="quartile-1788620216-0",CLASS="twitch-ad-quartile",START-DATE="2026-09-05T14:56:56.255Z",DURATION=2.000,X-TV-TWITCH-AD-QUARTILE="0"',
    ...blocks, ''
  ].join('\n')
}

test('a playlist carrying no advertising comes back exactly as Twitch wrote it', () => {
  const playlist = fixture('media-live.m3u8')
  assert.equal(withoutAds(playlist), playlist)
  assert.deepEqual([...new Set(segments(playlist))], ['live'])
})

test('a window holding nothing but advertising comes back whole', () => {
  // The pre-roll: filtering it would leave no segment at all, and hls.js reads an empty playlist
  // as a broken level rather than as a pause. The viewer sees this one.
  const playlist = fixture('media-preroll.m3u8')
  assert.deepEqual([...new Set(segments(playlist))], ['Amazon|2474283100494'])
  assert.equal(withoutAds(playlist), playlist)
})

test('advertising at the end of the window goes, the channel stays', () => {
  const filtered = withoutAds(midroll({ adsFirst: false }))
  assert.deepEqual(segments(filtered), ['live', 'live'])
  assert.ok(!filtered.includes('ad-3.ts') && !filtered.includes('ad-4.ts'))
  assert.ok(filtered.includes('live-1.ts') && filtered.includes('live-2.ts'))
  // The first segment did not move: the sequence number must not either.
  assert.equal(sequence(filtered), 820)
})

test('advertising ahead of the channel moves the sequence number by what it dropped', () => {
  const filtered = withoutAds(midroll({ adsFirst: true }))
  assert.deepEqual(segments(filtered), ['live', 'live'])
  // Two segments left before the first one kept: a number left behind would make the player take
  // the channel's segments for ones it has already played.
  assert.equal(sequence(filtered), 822)
})

test('what is dropped takes its own markers with it', () => {
  const filtered = withoutAds(midroll({ adsFirst: true }))
  // The discontinuity that opened the ad, the dates of its segments, the ad range and its
  // quartiles all describe content that is no longer there.
  assert.equal((filtered.match(/#EXT-X-DISCONTINUITY/g) ?? []).length, 1)
  assert.equal((filtered.match(/#EXT-X-PROGRAM-DATE-TIME/g) ?? []).length, 2)
  assert.ok(!filtered.includes('twitch-stitched-ad'))
  assert.ok(!filtered.includes('twitch-ad-quartile'))
  // What names the stream, on the other hand, stays: it is not ours to rewrite.
  assert.ok(filtered.includes('twitch-stream-source'))
})

test('a source that is not the channel and not an ad plays untouched', () => {
  // A rerun announces itself the same way a stitched ad does — by not being `live`. Nothing was
  // stitched into this one, so nothing may be taken out of it.
  const rerun = fixture('media-live.m3u8').replace(/X-TV-TWITCH-STREAM-SOURCE="live"/, 'X-TV-TWITCH-STREAM-SOURCE="rerun"').replace(/,live$/gm, ',rerun')
  assert.equal(withoutAds(rerun), rerun)
})

test('a playlist that never mentions an ad is not even walked', () => {
  const plain = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:4\n#EXTINF:2.000,live\nhttps://video-edge.example.net/a.ts\n'
  assert.equal(withoutAds(plain), plain)
})
