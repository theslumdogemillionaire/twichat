import test from 'node:test'
import assert from 'node:assert/strict'
import { badgeKey, mergeTwitchBadges, parseTwitchBadges } from '../src/main/twitch-badges-parse'

const image = (id: string, scale: number) => `https://static-cdn.jtvnw.net/badges/v1/${id}/${scale}`

const payload = {
  data: [
    { set_id: 'moderator', versions: [{ id: '1', image_url_1x: image('mod', 1), image_url_2x: image('mod', 2), title: 'Moderator' }] },
    // Version `0` is the badge of a subscriber Twitch has not bucketed yet: a real version id.
    { set_id: 'subscriber', versions: [
      { id: '0', image_url_1x: image('sub0', 1), image_url_2x: image('sub0', 2), title: 'Subscriber' },
      { id: '12', image_url_1x: image('sub12', 1), image_url_2x: image('sub12', 2), title: '1-Month Subscriber' }
    ] },
    { set_id: 'bits', versions: [{ id: '1000', image_url_1x: image('bits', 1), image_url_2x: image('bits', 2), title: 'cheer 1000' }] }
  ]
}

test('keys a badge by the pair the IRC tag carries, version zero included', () => {
  const badges = parseTwitchBadges(payload)
  assert.deepEqual(badges.map(badge => badge.id), ['moderator/1', 'subscriber/0', 'subscriber/12', 'bits/1000'])
  assert.equal(badges[1].url, image('sub0', 2))
  assert.equal(badges[3].title, 'cheer 1000')
  assert.equal(badgeKey('broadcaster', '1'), 'broadcaster/1')
})

test('falls back to the 1x file, and to the set name when Twitch titled nothing', () => {
  const [badge] = parseTwitchBadges({ data: [{ set_id: 'vip', versions: [{ id: '1', image_url_1x: image('vip', 1) }] }] })
  assert.deepEqual(badge, { id: 'vip/1', url: image('vip', 1), title: 'vip' })
})

test('drops what is not a badge served by Twitch', () => {
  const badges = parseTwitchBadges({
    data: [
      { set_id: 'ok', versions: [{ id: '1', image_url_2x: 'https://evil.example/badge.png' }] },
      { set_id: 'ok', versions: [{ id: '1', image_url_2x: 'http://static-cdn.jtvnw.net/badges/v1/x/2' }] },
      { set_id: '../evil', versions: [{ id: '1', image_url_2x: image('x', 2) }] },
      { set_id: 'ok', versions: [{ id: '../1', image_url_2x: image('x', 2) }] },
      { set_id: 'ok', versions: 'nope' },
      'nope'
    ]
  })
  assert.deepEqual(badges, [])
  assert.deepEqual(parseTwitchBadges(null), [])
  assert.deepEqual(parseTwitchBadges({ data: {} }), [])
})

test('the channel set takes the place of the global one it shares a key with', () => {
  const global = parseTwitchBadges(payload)
  const channel = parseTwitchBadges({ data: [{ set_id: 'subscriber', versions: [{ id: '0', image_url_2x: image('own', 2), title: 'Subscriber' }] }] })
  const merged = mergeTwitchBadges(global, channel)
  assert.equal(merged.find(badge => badge.id === 'subscriber/0')?.url, image('own', 2))
  // And nothing else moves: the global sets are a union with it, not a list it replaces.
  assert.equal(merged.length, global.length)
  assert.equal(merged.find(badge => badge.id === 'moderator/1')?.url, image('mod', 2))
})
