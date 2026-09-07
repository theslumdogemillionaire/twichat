import type { ThirdPartyEmote } from '../shared/types'
import { messageFragments } from './emotes'
import { channelSegments, linkSegments } from './links'
import { mentionSegments } from './mentions'

export interface MessageBodyOptions {
  /** Twitch's `emotes` tag, with the positions it alone gives. Absent from a whisper. */
  emoteTag?: string
  /** Twitch's `gifs` tag. Withheld by the setting, and absent from a whisper. */
  gifTag?: string
  thirdParty?: ReadonlyMap<string, ThirdPartyEmote>
  /** Names to images, for a body carrying no tag of its own: the only way left to match one. */
  twitchNames?: ReadonlyMap<string, string>
  links?: boolean
  /**
   * Whether `#a_channel` written in a body becomes a way in. On where a message names rooms one
   * may not have joined; off in the room itself, where the sidebar already holds them.
   */
  channels?: boolean
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
  // The channels come out before the nicknames: a room named inside an underlined mention would
  // be split in two, the same way a link would be.
  const appendText = (value: string) => {
    if (!options.channels) { appendMentions(value); return }
    for (const segment of channelSegments(value)) {
      if (!segment.channel) { appendMentions(segment.text); continue }
      const room = document.createElement('button')
      room.type = 'button'; room.className = 'message-channel'; room.dataset.channel = segment.channel
      room.textContent = segment.text
      target.append(room)
    }
  }
  for (const fragment of messageFragments(text, options.emoteTag ?? '', options.thirdParty, options.twitchNames, options.gifTag ?? '')) {
    if (fragment.type === 'text') {
      if (!options.links) { appendText(fragment.text); continue }
      // The links are cut out first: a nickname underlined inside an address would break it in two.
      for (const segment of linkSegments(fragment.text)) {
        if (!segment.url) { appendText(segment.text); continue }
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
