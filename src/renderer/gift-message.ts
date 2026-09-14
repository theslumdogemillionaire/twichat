import type { ChatMessage, GiftRecipient, RoomProfile, SubscriptionGift } from '../shared/types'
import { clock, m, numbers } from '../shared/i18n'
import { icon } from './icons'
import { giftIsForAccount } from './gift-groups'

const presentations = new WeakMap<SubscriptionGift, { seen: boolean; expanded: boolean }>()

function profileName(person: GiftRecipient, className: string): HTMLElement {
  const identified = /^[a-z0-9_]{1,25}$/.test(person.login)
  const node = document.createElement(identified ? 'button' : 'span')
  node.className = className; node.textContent = person.displayName
  if (identified) {
    (node as HTMLButtonElement).type = 'button'
    node.dataset.card = person.login
    node.setAttribute('aria-label', m.app.profileOf(person.displayName))
  }
  return node
}

interface GiftOptions {
  account: string | null
  avatar(login: string): string
  loadProfiles(logins: string[]): Promise<RoomProfile[]>
}
// Coalesce profile work across progressive recipient updates and virtual remounts.
const avatarRequests = new Map<string, { expires: number; result: Promise<string> }>()
function loadAvatars(logins: string[], options: GiftOptions) {
  const missing = [...new Set(logins)].filter(login => !options.avatar(login) && (!avatarRequests.has(login) || avatarRequests.get(login)!.expires < Date.now()))
  for (let offset = 0; offset < missing.length; offset += 100) {
    const batch = missing.slice(offset, offset + 100)
    const request = options.loadProfiles(batch).catch(() => [] as RoomProfile[])
    for (const login of batch) {
      const entry = { expires: Date.now() + 5 * 60_000, result: Promise.resolve('') }
      entry.result = request.then(profiles => {
        const url = profiles.find(profile => profile.channel === login)?.avatarUrl || ''
        if (!url) entry.expires = Date.now() + 30_000
        return url
      })
      avatarRequests.delete(login); avatarRequests.set(login, entry)
    }
    while (avatarRequests.size > 500) avatarRequests.delete(avatarRequests.keys().next().value!)
  }
}

export function createGiftMessage(message: ChatMessage, options: GiftOptions): HTMLElement {
  const gift = message.gift!
  const state = presentations.get(gift) ?? { seen: false, expanded: false }
  presentations.set(gift, state)
  const row = document.createElement('article'); row.className = 'message gift-message'
  const personal = giftIsForAccount(message, options.account)
  const card = document.createElement('div'); card.className = `gift-card${personal ? ' gift-for-you' : ''}`
  const age = Date.now() - message.time
  if (!state.seen && age >= 0 && age < 15_000) card.classList.add('gift-arriving')
  state.seen = true

  const header = document.createElement('div'); header.className = 'gift-header'
  const label = document.createElement('span'); label.textContent = m.chat.giftLabel
  const time = document.createElement('time'); time.className = 'message-time'
  time.dateTime = new Date(message.time).toISOString(); time.textContent = clock.format(message.time)
  header.append(label, time)
  const body = document.createElement('div'); body.className = 'gift-body'
  const symbol = document.createElement('span'); symbol.className = 'gift-symbol'; symbol.innerHTML = icon('gift')
  const content = document.createElement('div'); content.className = 'gift-content'
  const title = document.createElement('h3'); title.textContent = m.chat.giftTitle(gift.count === null ? null : numbers.format(gift.count), gift.count === 1)
  const sender = document.createElement('p'); sender.className = 'gift-sender'
  sender.append(document.createTextNode(`${m.chat.giftBy} `), profileName(gift, 'gift-name'))
  const meta = document.createElement('div'); meta.className = 'gift-meta'
  const plan = m.chat.subscriptionPlans[gift.plan]
  for (const text of [plan, gift.months && gift.months > 1 ? m.chat.giftMonths(gift.months) : '']) {
    if (!text) continue
    const tag = document.createElement('span'); tag.textContent = text; meta.append(tag)
  }
  // Plan and duration ride the sender line: two lines beside the icon instead of three.
  const byline = document.createElement('div'); byline.className = 'gift-byline'
  byline.append(sender, meta)
  content.append(title, byline); body.append(symbol, content)
  card.append(header, body)

  const recipients = [...(gift.kind === 'single' && gift.recipient ? [gift.recipient] : message.giftRecipients ?? [])]
  // The signed-in recipient leaves the stack for the tag that closes it: always at the end, always
  // visible whatever the size of the bundle, and named rather than ringed among strangers.
  const you = personal ? recipients.find(recipient => recipient.login === options.account?.toLowerCase()) : undefined
  const others = you ? recipients.filter(recipient => recipient !== you) : recipients
  // One slot of the eight goes to the tag, so the hidden count stays the same either way.
  const room = you ? 7 : 8
  if (recipients.length) {
    const footer = document.createElement('div'); footer.className = 'gift-recipients'
    footer.setAttribute('role', 'group')
    footer.setAttribute('aria-label', m.chat.giftRecipients)
    const list = document.createElement('div'); list.className = 'gift-recipient-list'
    list.id = `gift-recipients-${message.id}`
    list.setAttribute('role', 'list')
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'gift-expand'
    toggle.setAttribute('aria-controls', list.id)
    function recipientAvatar(recipient: GiftRecipient): HTMLElement {
      const avatar = profileName(recipient, 'gift-recipient gift-avatar')
      avatar.textContent = Array.from(recipient.displayName)[0] || '?'
      avatar.title = recipient.displayName
      if (recipient === you) {
        avatar.classList.add('is-you')
        avatar.title = `${recipient.displayName} · ${m.chat.giftYou}`
      }
      function paint(url: string) {
        if (!url || avatar.querySelector('img')) return
        const image = document.createElement('img'); image.width = 38; image.height = 38; image.alt = ''
        image.addEventListener('error', () => image.remove(), { once: true })
        image.src = url; avatar.append(image)
      }
      const cached = options.avatar(recipient.login)
      if (cached) paint(cached)
      else void avatarRequests.get(recipient.login)?.result.then(paint)
      return avatar
    }
    function paintRecipients() {
      list.replaceChildren()
      const visible = state.expanded ? others : others.slice(0, room)
      list.classList.toggle('expanded', state.expanded)
      loadAvatars(visible.map(recipient => recipient.login).filter(Boolean), options)
      for (const recipient of visible) {
        const item = document.createElement('span'); item.setAttribute('role', 'listitem')
        item.append(recipientAvatar(recipient)); list.append(item)
      }
      toggle.hidden = others.length <= room
      toggle.textContent = state.expanded ? m.chat.giftLess : `+${others.length - room}`
      toggle.setAttribute('aria-label', state.expanded ? m.chat.giftLess : m.chat.giftMore(others.length - room))
      toggle.setAttribute('aria-expanded', String(state.expanded))
    }
    toggle.addEventListener('click', () => { state.expanded = !state.expanded; paintRecipients() })
    paintRecipients(); footer.append(list, toggle)
    if (you) {
      loadAvatars([you.login].filter(Boolean), options)
      const tag = document.createElement('p'); tag.className = 'gift-tag'
      tag.append(recipientAvatar(you), document.createTextNode(m.chat.giftForYou))
      footer.append(tag)
    }
    card.append(footer)
  }
  row.append(card)
  return row
}
