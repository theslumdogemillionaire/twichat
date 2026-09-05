import test from 'node:test'
import assert from 'node:assert/strict'
import { exemptFromFollowersOnly, followDelay, followNotice, followersOnlyMinutes } from '../src/renderer/follow-gate'
import { parseFollowedAt } from '../src/main/twitch-data-parse'
import { setLocale } from '../src/shared/i18n'
// English is the default language since `en.ts` became the source of truth. The assertions
// below read the French catalog, so the language is pinned rather than inherited.
setLocale('fr')


test('reads the "followers-only" mode of a ROOMSTATE without confusing "off" with "following is enough"', () => {
  assert.equal(followersOnlyMinutes('-1'), null)
  assert.equal(followersOnlyMinutes(undefined), null)
  assert.equal(followersOnlyMinutes(''), null)
  assert.equal(followersOnlyMinutes('0'), 0)
  assert.equal(followersOnlyMinutes('30'), 30)
  assert.equal(followersOnlyMinutes('4320'), 4320)
  assert.equal(followersOnlyMinutes('trente'), null)
})

test('states a follow duration the way Twitch sets it, never in thousands of minutes', () => {
  assert.equal(followDelay(1), '1 minute')
  assert.equal(followDelay(30), '30 minutes')
  assert.equal(followDelay(60), '1 heure')
  assert.equal(followDelay(150), '2 h 30')
  assert.equal(followDelay(1440), '1 jour')
  assert.equal(followDelay(4320), '3 jours')
  assert.equal(followDelay(4500), '3 jours et 3 h')
})

test('the badges that exempt from "followers-only" mode clear the banner', () => {
  assert.equal(exemptFromFollowersOnly(['moderator']), true)
  assert.equal(exemptFromFollowersOnly(['subscriber', 'glhf-pledge']), true)
  assert.equal(exemptFromFollowersOnly(['broadcaster']), true)
  assert.equal(exemptFromFollowersOnly(['vip']), true)
  assert.equal(exemptFromFollowersOnly(['founder']), true)
  assert.equal(exemptFromFollowersOnly(['premium', 'glhf-pledge']), false)
  // A decorative badge exempts nobody: only what Twitch exempts counts.
  assert.equal(exemptFromFollowersOnly(['bits', 'partner', 'staff']), false)
  assert.equal(exemptFromFollowersOnly(undefined), false)
})

const known = (followedAt: string) => ({ channel: 'ponce', known: true, following: !!followedAt, followedAt })

test('shows a banner only when something is still missing to write', () => {
  // Room open to everyone, or the answer not back yet: nothing is shown.
  assert.equal(followNotice(null, known(''), 'ponce'), null)
  assert.equal(followNotice(0, undefined, 'ponce'), null)
  // Follow old enough for the required delay.
  const now = Date.parse('2026-09-05T12:00:00Z')
  assert.equal(followNotice(30, known('2026-09-05T11:00:00Z'), 'ponce', now), null)
  assert.equal(followNotice(0, known('2026-09-05T11:59:59Z'), 'ponce', now), null)
})

test('names the required delay rather than announcing an abstract "followers-only" mode', () => {
  const now = Date.parse('2026-09-05T12:00:00Z')
  const stranger = followNotice(4320, known(''), 'ponce', now)
  assert.equal(stranger?.title, 'Suivez #ponce pour écrire ici.')
  assert.equal(stranger?.detail, 'Cette chaîne n’accepte que les comptes qui la suivent depuis au moins 3 jours.')
  assert.equal(stranger?.follow, true)
  assert.equal(followNotice(0, known(''), 'ponce', now)?.detail, 'Cette chaîne n’accepte que les comptes qui la suivent.')
})

test('counts the time left when the channel has been followed for too short a while', () => {
  const now = Date.parse('2026-09-05T12:00:00Z')
  const waiting = followNotice(30, known('2026-09-05T11:50:00Z'), 'ponce', now)
  assert.equal(waiting?.title, 'Encore 20 minutes avant de pouvoir écrire ici.')
  assert.equal(waiting?.detail, 'Vous suivez #ponce depuis 10 minutes, et cette chaîne en demande 30 minutes.')
  // The follow is already done: the button to Twitch has nothing left to offer.
  assert.equal(waiting?.follow, false)
})

test('a token without user:read:follows costs the precise wording, never the channel', () => {
  const notice = followNotice(30, { channel: 'ponce', known: false, following: false, followedAt: '' }, 'ponce')
  assert.equal(notice?.title, '#ponce n’accepte que les messages des followers.')
  assert.equal(notice?.follow, true)
})

test('reads the follow date returned by channels/followed filtered on one channel', () => {
  assert.equal(parseFollowedAt({ data: [{ followed_at: '2026-09-01T08:30:00Z' }], total: 1 }), '2026-09-01T08:30:00Z')
  // The account does not follow: Twitch returns an empty list, never an error.
  assert.equal(parseFollowedAt({ data: [], total: 0 }), '')
  assert.equal(parseFollowedAt({ data: [{ followed_at: 'la semaine dernière' }] }), '')
  assert.equal(parseFollowedAt(null), '')
})
