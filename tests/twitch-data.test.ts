import test from 'node:test'
import assert from 'node:assert/strict'
import { combineHelix, followerTotal, helixUsersToProfiles, helixUserToCard, offlineFollowed, parseFollowedChannels, parsePublicProfile, safeThumbnail } from '../src/main/twitch-data-parse'

test('extracts a public Twitch avatar without exposing a third-party URL', () => {
  const profile = parsePublicProfile('Ponce', `
    <meta property="og:image" content="https://static-cdn.jtvnw.net/jtv_user_pictures/ponce-profile_image-70x70.png">
    <meta property="og:title" content="Ponce - Live on Twitch">
    <meta name="description" content="Ponce streams for 12,345 viewers | Streaming Just Chatting">
    <script>{"uploadDate":"2026-09-04T15:48:03Z","publication":{"@type":"BroadcastEvent","endDate":"2026-09-05T00:04:34Z","startDate":"2026-09-04T15:48:03Z","isLiveBroadcast":true}}</script>
  `)
  assert.deepEqual(profile, {
    channel: 'ponce', displayName: 'Ponce', avatarUrl: 'https://static-cdn.jtvnw.net/jtv_user_pictures/ponce-profile_image-70x70.png',
    live: true, viewers: 12345, title: 'Ponce streams for 12,345 viewers', startedAt: '2026-09-04T15:48:03Z'
  })
  // Reruns listed under the live stream carry their own date: only the live stream's own date counts.
  assert.equal(parsePublicProfile('ponce', '<script>{"publication":{"startDate":"2026-08-30T10:00:00Z","isLiveBroadcast":false}},{"uploadDate":"2026-08-29T10:00:00Z"}</script>').startedAt, undefined)
  assert.equal(parsePublicProfile('ponce', '<script>{"publication":{"startDate":"hier","isLiveBroadcast":true}}</script>').startedAt, undefined)
  assert.equal(parsePublicProfile('ponce', '<meta property="og:image" content="https://example.com/tracker.png">').avatarUrl, '')
  assert.equal(parsePublicProfile('anyme023', '<meta property="og:title" content="Anyme023 - Live sur Twitch">').displayName, 'Anyme023')
  assert.equal(parsePublicProfile('zerator', '<meta name="description" content="Stream de zevent pour 31 473 viewers.">').viewers, 31473)
})

test('assembles and sorts the Helix catalog with tags and viewer counts', () => {
  const streams = combineHelix([
    { id: '1', user_id: 'u1', user_login: 'petitchat', user_name: 'PetitChat', title: 'On discute', game_name: 'Just Chatting', viewer_count: 42, tags: ['Français', 'Discussion'], language: 'fr', started_at: '2026-09-04T18:00:00Z', thumbnail_url: 'https://static-cdn.jtvnw.net/previews-ttv/live_user_petitchat-{width}x{height}.jpg' },
    { id: '2', user_id: 'u2', user_login: 'grandchat', user_name: 'GrandChat', title: 'Très actif', game_name: 'Talk Shows', viewer_count: 113000, tags: ['Français'], language: 'fr', started_at: '2026-09-04T17:00:00Z' }
  ], [
    { id: 'u1', profile_image_url: 'https://static-cdn.jtvnw.net/avatar-one.png' },
    { id: 'u2', profile_image_url: 'https://static-cdn.jtvnw.net/avatar-two.png' }
  ])
  assert.deepEqual(streams.map(stream => [stream.channel, stream.viewers]), [['grandchat', 113000], ['petitchat', 42]])
  assert.deepEqual(streams[1].tags, ['Français', 'Discussion'])
  assert.equal(streams[0].avatarUrl, 'https://static-cdn.jtvnw.net/avatar-two.png')
  assert.equal(streams[1].thumbnailUrl, 'https://static-cdn.jtvnw.net/previews-ttv/live_user_petitchat-440x248.jpg')
  assert.equal(streams[0].thumbnailUrl, '')
})

test('substitutes the thumbnail dimensions before validating its domain', () => {
  // Substituting after parsing would leave percent-encoded braces and a dead image.
  assert.equal(
    safeThumbnail('https://static-cdn.jtvnw.net/previews-ttv/live_user_ponce-{width}x{height}.jpg', 320, 180),
    'https://static-cdn.jtvnw.net/previews-ttv/live_user_ponce-320x180.jpg'
  )
  assert.equal(safeThumbnail('https://example.com/preview-{width}x{height}.jpg'), '')
  assert.equal(safeThumbnail('http://static-cdn.jtvnw.net/preview.jpg'), '')
  assert.equal(safeThumbnail(undefined), '')
  assert.equal(safeThumbnail(`https://static-cdn.jtvnw.net/${'a'.repeat(1001)}.jpg`), '')
})

test('converts Helix profiles into avatars safe for chat', () => {
  const profiles = helixUsersToProfiles([
    { login: 'Alice_42', display_name: 'Alice', profile_image_url: 'https://static-cdn.jtvnw.net/alice.png' },
    { login: 'tracker', display_name: 'Tracker', profile_image_url: 'https://example.com/tracker.png' }
  ])
  assert.deepEqual(profiles.map(profile => [profile.channel, profile.displayName, profile.avatarUrl]), [
    ['alice_42', 'Alice', 'https://static-cdn.jtvnw.net/alice.png'], ['tracker', 'Tracker', '']
  ])
})

test('builds a profile card and discards hostile fields', () => {
  const card = helixUserToCard([{
    id: '42', login: 'Ponce', display_name: 'Ponce', profile_image_url: 'https://static-cdn.jtvnw.net/ponce.png',
    description: 'Je\u0000 parle\n de tout', broadcaster_type: 'partner', created_at: '2013-04-12T10:00:00Z'
  }])
  assert.deepEqual(card, {
    login: 'ponce', displayName: 'Ponce', avatarUrl: 'https://static-cdn.jtvnw.net/ponce.png',
    description: 'Je  parle  de tout', broadcasterType: 'partner', createdAt: '2013-04-12T10:00:00Z', live: false
  })
  assert.equal(helixUserToCard([{ login: 'x', profile_image_url: 'https://evil.example/pic.png' }])?.avatarUrl, '')
  assert.equal(helixUserToCard([{ login: 'x', broadcaster_type: 'staff' }])?.broadcasterType, '')
  assert.equal(helixUserToCard([{ login: 'nom invalide' }]), null)
  assert.equal(helixUserToCard([]), null)
  assert.equal(helixUserToCard(null), null)
})

test('keeps a follower total only when it is a positive integer', () => {
  assert.equal(followerTotal({ total: 12345, data: [] }), 12345)
  assert.equal(followerTotal({ total: 0 }), 0)
  assert.equal(followerTotal({ total: -3 }), undefined)
  assert.equal(followerTotal({ error: 'Unauthorized' }), undefined)
  assert.equal(followerTotal(null), undefined)
})

test('reads the followed list with no duplicate or suspicious login', () => {
  const followed = parseFollowedChannels([
    { broadcaster_id: '42', broadcaster_login: 'Ponce', broadcaster_name: 'Ponce' },
    { broadcaster_id: '42', broadcaster_login: 'ponce', broadcaster_name: 'Ponce' },
    { broadcaster_id: 'abc', broadcaster_login: 'zerator', broadcaster_name: '' },
    { broadcaster_id: '7', broadcaster_login: 'nom invalide', broadcaster_name: 'Nope' }
  ])
  assert.deepEqual(followed, [
    { id: '42', channel: 'ponce', displayName: 'Ponce' },
    { id: '', channel: 'zerator', displayName: 'zerator' }
  ])
  assert.deepEqual(parseFollowedChannels(null), [])
})

test('keeps offline only the followed channels missing from the live streams', () => {
  const followed = parseFollowedChannels([
    { broadcaster_id: '1', broadcaster_login: 'petitchat', broadcaster_name: 'PetitChat' },
    { broadcaster_id: '2', broadcaster_login: 'zibbi', broadcaster_name: 'Zibbi' },
    { broadcaster_id: '3', broadcaster_login: 'anaon', broadcaster_name: 'Anaon' }
  ])
  const live = combineHelix([
    { id: 's1', user_id: '1', user_login: 'petitchat', user_name: 'PetitChat', viewer_count: 12 }
  ], [])
  const offline = offlineFollowed(followed, live, [
    { id: '2', profile_image_url: 'https://static-cdn.jtvnw.net/zibbi.png' },
    { id: '3', profile_image_url: 'https://exemple.test/anaon.png' }
  ])
  assert.deepEqual(offline, [
    { channel: 'anaon', displayName: 'Anaon', avatarUrl: '', live: false },
    { channel: 'zibbi', displayName: 'Zibbi', avatarUrl: 'https://static-cdn.jtvnw.net/zibbi.png', live: false }
  ])
})
