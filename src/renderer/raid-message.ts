import type { ChatMessage } from '../shared/types'
import { clock, m, numbers } from '../shared/i18n'
import { icon } from './icons'

// Rows are remounted while scrolling and refreshed when emotes arrive. Celebrate once per
// message object, without keeping evicted history alive or animating old raids on a room switch.
const presented = new WeakSet<ChatMessage>()
const avatars = new Map<string, { expires: number; result: Promise<string> }>()

function raidAvatar(login: string): Promise<string> {
  const cached = avatars.get(login)
  if (cached && cached.expires > Date.now()) return cached.result
  const entry = { expires: Date.now() + 5 * 60_000, result: Promise.resolve('') }
  entry.result = window.twichat.profiles([login]).then(profiles => {
    const url = profiles.find(profile => profile.channel === login)?.avatarUrl || ''
    if (!url) entry.expires = Date.now() + 30_000
    return url
  }).catch(() => { entry.expires = Date.now() + 30_000; return '' })
  avatars.delete(login)
  avatars.set(login, entry)
  if (avatars.size > 80) avatars.delete(avatars.keys().next().value!)
  return entry.result
}

export function createRaidMessage(message: ChatMessage, cachedAvatar = '', onAvatar: (url: string) => void = () => {}): HTMLElement {
  const raid = message.raid!
  const identified = /^[a-z0-9_]{1,25}$/.test(raid.login)
  const row = document.createElement('article'); row.className = 'message raid-message'
  row.setAttribute('aria-label', message.text)
  const card = document.createElement('div'); card.className = 'raid-card'
  const age = Date.now() - message.time
  if (!presented.has(message) && age >= 0 && age < 15_000) card.classList.add('raid-arriving')
  presented.add(message)

  const heading = document.createElement('div'); heading.className = 'raid-heading'
  const label = document.createElement('span'); label.className = 'raid-label'
  label.innerHTML = icon('bolt'); label.append(document.createTextNode(m.chat.raidLabel))
  const time = document.createElement('time'); time.className = 'message-time'
  time.dateTime = new Date(message.time).toISOString(); time.textContent = clock.format(message.time)
  heading.append(label, time)

  const body = document.createElement('div'); body.className = 'raid-body'
  const avatar = document.createElement(identified ? 'button' : 'span'); avatar.className = 'raid-avatar'
  avatar.textContent = Array.from(raid.displayName)[0] || '?'
  if (identified) {
    (avatar as HTMLButtonElement).type = 'button'
    avatar.dataset.card = raid.login
    avatar.setAttribute('aria-label', m.app.profileOf(raid.displayName))
  }
  function paintAvatar(url: string) {
    if (!url) return
    const image = document.createElement('img'); image.alt = ''; image.width = 64; image.height = 64
    image.addEventListener('load', () => onAvatar(url), { once: true })
    image.addEventListener('error', () => image.remove(), { once: true })
    image.src = url; avatar.append(image)
  }
  const avatarUrl = raid.avatarUrl || cachedAvatar
  if (avatarUrl) paintAvatar(avatarUrl)
  else if (identified) void raidAvatar(raid.login).then(paintAvatar)

  const identity = document.createElement('div'); identity.className = 'raid-identity'
  const name = document.createElement('strong'); name.className = 'raid-name'; name.textContent = raid.displayName
  const arrival = document.createElement('p'); arrival.textContent = m.chat.raidArrival
  identity.append(name, arrival)
  body.append(avatar, identity)
  if (raid.viewers !== null) {
    const crowd = document.createElement('div'); crowd.className = 'raid-crowd'
    const count = document.createElement('strong'); count.textContent = numbers.format(raid.viewers)
    const viewers = document.createElement('span'); viewers.textContent = m.chat.raidViewers(raid.viewers)
    crowd.append(count, viewers); body.append(crowd)
  }

  const footer = document.createElement('div'); footer.className = 'raid-footer'
  const welcome = document.createElement('span'); welcome.textContent = m.chat.raidWelcome
  footer.append(welcome)
  if (identified) {
    const profile = document.createElement('button'); profile.type = 'button'; profile.className = 'raid-profile'
    profile.dataset.card = raid.login; profile.textContent = m.chat.raidProfile
    profile.setAttribute('aria-label', m.app.profileOf(raid.displayName))
    const arrow = document.createElement('span'); arrow.innerHTML = icon('arrow'); profile.append(arrow)
    footer.append(profile)
  }
  card.append(heading, body, footer); row.append(card)
  return row
}
