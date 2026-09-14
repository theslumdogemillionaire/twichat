import type { ChatMessage, CommunityNotice } from '../shared/types'
import { clock, m, numbers } from '../shared/i18n'
import { icon } from './icons'

const presented = new WeakSet<object>()
const isRecent = (message: ChatMessage) => Date.now() >= message.time && Date.now() - message.time < 15_000

interface CommunityOptions {
  avatar(login: string): string
  requestAvatar(login: string): void
  paintBody(target: HTMLElement, message: ChatMessage): void
}

function copy(notice: CommunityNotice) {
  switch (notice.kind) {
    case 'subscription': return {
      label: notice.renewal ? m.chat.eventResubscription : m.chat.eventSubscription,
      title: !notice.renewal ? m.chat.eventNewSub : notice.months ? m.chat.eventSubDuration(notice.months) : m.chat.eventRenewedSub,
      symbol: 'heart'
    }
    case 'announcement': return { label: m.chat.eventAnnouncement, title: '', symbol: 'megaphone' }
    case 'watch-streak': return { label: m.chat.eventStreak, title: m.chat.eventStreakValue(notice.value), symbol: 'flame' }
    case 'bits-badge': return { label: m.chat.eventBitsBadge, title: `${numbers.format(notice.value)} Bits`, symbol: 'diamond' }
    case 'modiversary': return { label: m.chat.eventModiversary, title: m.chat.eventModDuration(notice.value), symbol: 'verified' }
  }
}

export function createCommunityMessage(message: ChatMessage, options: CommunityOptions): HTMLElement {
  const notice = message.communityNotice!
  const words = copy(notice)
  const row = document.createElement('article'); row.className = 'message community-message'
  const card = document.createElement('div'); card.className = `community-card event-${notice.kind}`
  if (notice.kind === 'announcement') card.dataset.color = notice.color.toLowerCase()
  if (notice.kind === 'subscription' && notice.months && notice.months >= 6 && notice.months % 6 === 0) card.classList.add('event-anniversary')
  if (!presented.has(notice) && isRecent(message)) card.classList.add('event-arriving')
  presented.add(notice)
  const header = document.createElement('div'); header.className = 'community-heading'
  const label = document.createElement('span'); label.innerHTML = icon(words.symbol); label.append(document.createTextNode(words.label))
  const time = document.createElement('time'); time.className = 'message-time'; time.dateTime = new Date(message.time).toISOString(); time.textContent = clock.format(message.time)
  header.append(label, time); card.append(header)

  const identity = document.createElement('div'); identity.className = 'community-identity'
  const identified = /^[a-z0-9_]{1,25}$/.test(notice.login)
  const avatar = document.createElement(identified ? 'button' : 'span'); avatar.className = 'message-avatar community-avatar'; avatar.textContent = Array.from(notice.displayName)[0] || '?'
  const name = document.createElement(identified ? 'button' : 'span'); name.className = 'community-name'; name.textContent = notice.displayName
  if (identified) {
    for (const node of [avatar, name]) {
      (node as HTMLButtonElement).type = 'button'; node.dataset.card = notice.login
      node.setAttribute('aria-label', m.app.profileOf(notice.displayName))
    }
    avatar.dataset.login = notice.login
    const source = options.avatar(notice.login)
    if (source) {
      const image = document.createElement('img'); image.width = 46; image.height = 46; image.alt = ''; image.src = source
      image.addEventListener('error', () => image.remove(), { once: true }); avatar.append(image)
    } else options.requestAvatar(notice.login)
  }
  const content = document.createElement('div'); content.className = 'community-content'
  if (words.title) { const title = document.createElement('h3'); title.textContent = words.title; content.append(title) }
  const author = document.createElement('div'); author.className = 'community-author'; author.append(name)
  if (notice.kind === 'subscription' && m.chat.subscriptionPlans[notice.plan]) {
    const plan = document.createElement('span'); plan.className = 'community-plan'; plan.textContent = m.chat.subscriptionPlans[notice.plan]; author.append(plan)
  }
  content.append(author); identity.append(avatar, content); card.append(identity)
  if (message.noticeBody) {
    const body = document.createElement('div'); body.className = 'community-body'
    body.dataset.contextMessage = message.noticeBody.id
    const text = document.createElement('p'); text.className = 'message-text'
    options.paintBody(text, message.noticeBody); body.append(text); card.append(body)
  }
  row.append(card)
  return row
}

/** Product thresholds for presentation, based only on Twitch's authoritative total Bits tag. */
export function cheerEmphasis(bits: number | undefined): 'notable' | 'large' | 'huge' | undefined {
  if (!bits || !Number.isSafeInteger(bits)) return undefined
  return bits >= 10_000 ? 'huge' : bits >= 5_000 ? 'large' : bits >= 1_000 ? 'notable' : undefined
}

/** Wrap the ordinary message to keep its replies, emotes, links, mention state and context menu. */
export function decorateCheer(row: HTMLElement, message: ChatMessage): void {
  const emphasis = cheerEmphasis(message.bits)
  if (!emphasis) return
  row.classList.add('cheer-message')
  const card = document.createElement('div'); card.className = `cheer-card cheer-${emphasis}`
  if (!presented.has(message) && isRecent(message)) card.classList.add('event-arriving')
  presented.add(message)
  const heading = document.createElement('div'); heading.className = 'cheer-heading'
  const symbol = document.createElement('span'); symbol.className = 'cheer-gem'; symbol.innerHTML = icon('diamond')
  const amount = document.createElement('strong'); amount.textContent = `${numbers.format(message.bits!)} Bits`
  const label = document.createElement('span'); label.className = 'cheer-label'; label.textContent = m.chat.eventCheerThanks
  heading.append(symbol, amount, label)
  const body = document.createElement('div'); body.className = 'cheer-body'; body.append(...row.childNodes)
  card.append(heading, body); row.append(card)
}
