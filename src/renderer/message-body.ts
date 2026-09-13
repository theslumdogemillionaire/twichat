import type { Cheermote, ThirdPartyEmote } from '../shared/types'
import { cheerSegments } from './cheers'
import { numbers } from '../shared/i18n'
import { messageFragments } from './emotes'
import { channelFromUrl, channelSegments, handleSegments, linkSegments } from './links'
import { mentionSegments } from './mentions'

export interface MessageBodyOptions {
  /** Twitch's `emotes` tag, with the positions it alone gives. Absent from a whisper. */
  emoteTag?: string
  /** Twitch's `gifs` tag. Withheld by the setting, and absent from a whisper. */
  gifTag?: string
  thirdParty?: ReadonlyMap<string, ThirdPartyEmote>
  /** Names to images, for a body carrying no tag of its own: the only way left to match one. */
  twitchNames?: ReadonlyMap<string, string>
  /**
   * The room's cheer prefixes, keyed lowercase. Handed over only for a message that carries a
   * `bits` tag: without one, `Cheer100` in a body is five characters somebody typed, and Twitch
   * counted nothing.
   */
  cheermotes?: ReadonlyMap<string, Cheermote>
  links?: boolean
  /**
   * Whether a channel named in a body becomes a way in — `#a_channel`, and the `twitch.tv`
   * address that says the same thing. On everywhere a message is read: a room named in a chat is
   * almost always one the reader has not joined, which is the whole point of a shoutout. What the
   * sidebar already holds is beside the question; it is the rest that needs the door.
   */
  channels?: boolean
  /**
   * Whether `@someone` written in a body opens that viewer's card. On in the room, where the card
   * hangs off `data-card`; off in the conversation windows, which have no card to open — a button
   * there would answer a click with nothing.
   */
  handles?: boolean
  /** The account's own nickname, underlined where it appears. Absent where a mention means nothing. */
  mention?: { login: string | null; displayName?: string | null }
  /**
   * Whether the links inside may be reached with the keyboard. Off in the room, where the
   * virtualised log would put hundreds of them between the reader and the composer; on
   * anywhere the messages are few.
   */
  focusableLinks?: boolean
}

/**
 * The body of a message, painted into `target`. One function for every place a message is read —
 * the room, and the conversation windows — so that the rules cannot drift apart: the same emotes,
 * the same links, the same fallbacks when an image fails to load.
 *
 * What differs between callers is what the data allows, never the rendering: a whisper carries no
 * `emotes` tag and no `gifs` tag, so it matches emotes by name and shows no GIF, because Twitch
 * sent neither the positions nor the addresses — not because it is read in another window.
 */
export function paintMessageBody(target: HTMLElement, text: string, options: MessageBodyOptions = {}): void {
  const { mention } = options
  // A reply to one of your own messages is a mention with no nickname in the text: nothing to underline.
  const appendMentions = (value: string) => {
    if (!mention) { target.append(document.createTextNode(value)); return }
    for (const segment of mentionSegments(value, mention.login, mention.displayName)) {
      if (!segment.mention) { target.append(document.createTextNode(segment.text)); continue }
      const marked = document.createElement('b'); marked.className = 'message-mention'; marked.textContent = segment.text
      target.append(marked)
    }
  }
  // Where the message addresses you, your own nickname stays the mention chip rather than turning
  // into a handle: the chip is what makes the line findable in a log going past.
  const own = mention?.login?.toLowerCase() ?? ''
  const appendHandles = (value: string) => {
    if (!options.handles) { appendMentions(value); return }
    for (const segment of handleSegments(value)) {
      if (!segment.login || segment.login === own) { appendMentions(segment.text); continue }
      const handle = document.createElement('button')
      handle.type = 'button'; handle.className = 'message-handle'; handle.dataset.card = segment.login
      handle.textContent = segment.text
      // Not a tab stop in the room: the virtualised log would put hundreds of them between the
      // reader and the composer.
      if (!options.focusableLinks) handle.tabIndex = -1
      target.append(handle)
    }
  }
  // The channels come out before the nicknames: a room named inside an underlined mention would
  // be split in two, the same way a link would be.
  const appendText = (value: string) => {
    if (!options.channels) { appendHandles(value); return }
    for (const segment of channelSegments(value)) {
      if (!segment.channel) { appendHandles(segment.text); continue }
      const room = document.createElement('button')
      room.type = 'button'; room.className = 'message-channel'; room.dataset.channel = segment.channel
      room.textContent = segment.text
      // Out of the tab order in the room, for the reason the handles and the links are: the
      // virtualised log would stand hundreds of stops between the reader and the composer.
      if (!options.focusableLinks) room.tabIndex = -1
      target.append(room)
    }
  }
  /**
   * The cheers, cut out of what is left of a text fragment. The position in this chain matters
   * far less than the position against `messageFragments` below, which has already read the
   * `emotes` and `gifs` offsets off the untouched body — see `cheers.ts`. A cheer token holds no
   * `@`, no `#` and no address, so the splits it passes through leave it whole either way.
   */
  const appendBody = (value: string) => {
    if (!options.cheermotes?.size) { appendText(value); return }
    for (const segment of cheerSegments(value, options.cheermotes)) {
      if (!segment.cheer) { appendText(segment.text); continue }
      const { prefix, bits, tier } = segment.cheer
      const image = document.createElement('img')
      image.className = 'message-cheer'
      // The prefix alone: the amount is written beside the image, so an alternative text carrying
      // it too would have a screen reader say the number twice.
      image.alt = prefix; image.title = segment.text
      image.loading = 'lazy'; image.decoding = 'async'
      // Same fallback as an emote that fails: the word Twitch wrote takes the image's place, and
      // the amount beside it puts the token back together.
      image.addEventListener('error', () => image.replaceWith(document.createTextNode(prefix)), { once: true })
      image.src = tier.url
      const amount = document.createElement('b')
      amount.className = 'message-cheer-amount'; amount.textContent = numbers.format(bits)
      // Twitch's own tier colour, which is the whole grammar of a cheer. Validated on the way out
      // of the network, so what reaches a style property here can only be `#rrggbb`.
      if (tier.color) amount.style.setProperty('--cheer', tier.color)
      target.append(image, amount)
    }
  }
  for (const fragment of messageFragments(text, options.emoteTag ?? '', options.thirdParty, options.twitchNames, options.gifTag ?? '')) {
    if (fragment.type === 'text') {
      if (!options.links) { appendBody(fragment.text); continue }
      // The links are cut out first: a nickname underlined inside an address would break it in two.
      for (const segment of linkSegments(fragment.text)) {
        if (!segment.url) { appendBody(segment.text); continue }
        // A `twitch.tv` address is a room rather than somewhere to send the reader: it opens in
        // place, like `#studio_nova`, and asks none of the questions a departure asks.
        const named = options.channels ? channelFromUrl(segment.url) : ''
        if (named) {
          const room = document.createElement('button')
          room.type = 'button'; room.className = 'message-channel'; room.dataset.channel = named
          room.textContent = segment.text
          if (!options.focusableLinks) room.tabIndex = -1
          target.append(room)
          continue
        }
        const link = document.createElement('a')
        link.className = 'message-link'; link.href = segment.url; link.textContent = segment.text
        // The address in full, on hover: what is written is not always where the click leads.
        link.title = segment.url; link.rel = 'noreferrer noopener'
        if (!options.focusableLinks) link.tabIndex = -1
        target.append(link)
      }
      continue
    }
    if (fragment.type === 'gif') {
      const gif = document.createElement('img')
      gif.className = 'message-gif'; gif.alt = fragment.text; gif.title = `${fragment.text} · GIPHY`
      gif.loading = 'lazy'; gif.decoding = 'async'
      // Same fallback as an emote that fails: the title Twitch wrote takes the image's place,
      // rather than a broken frame in the middle of a sentence.
      gif.addEventListener('error', () => gif.replaceWith(document.createTextNode(fragment.text)), { once: true })
      // The address goes in whole, as Twitch gave it: its documentation forbids rewriting one.
      gif.src = fragment.url
      target.append(gif)
      continue
    }
    const image = document.createElement('img')
    const source = fragment.source === 'twitch' ? 'Twitch' : fragment.source === '7tv' ? '7TV' : fragment.source === 'bttv' ? 'BetterTTV' : 'FrankerFaceZ'
    image.className = 'message-emote'; image.alt = fragment.text; image.title = `${fragment.text} · ${source}`; image.loading = 'lazy'; image.decoding = 'async'
    image.addEventListener('error', () => image.replaceWith(document.createTextNode(fragment.text)), { once: true })
    image.src = fragment.url
    target.append(image)
  }
}
