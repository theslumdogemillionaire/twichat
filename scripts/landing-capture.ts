import { _electron as electron } from 'playwright'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * The capture's language. The app's interface is visible in it: every landing page must
 * show its own, otherwise an English-speaking reader gets a capture in French.
 */
// Passed as an argument rather than through the environment: `LOCALE=en node …` in an npm
// script only works where the shell is a Unix one.
const locale = (process.argv[2] ?? process.env.TWICHAT_LOCALE) === 'en' ? 'en' : 'fr'
const assets = resolve('server/public/assets')
const sprite = `data:image/png;base64,${(await readFile(resolve('server/demo-assets/avatar-sprite.png'))).toString('base64')}`
const stream = `data:image/png;base64,${(await readFile(resolve('server/demo-assets/stream-frame.png'))).toString('base64')}`
await mkdir(assets, { recursive: true })

/** The demo faces live in a 4 × 3 sprite sheet: the crop is computed here, the page only receives a style. */
const avatarStyle = (index: number) =>
  `background-image:url(${sprite});background-size:400% 300%;background-position:${index % 4 * 100 / 3}% ${Math.floor(index / 4) * 50}%;background-repeat:no-repeat`

/**
 * Real emotes, served by the four hosts already allowed in the renderer CSP.
 * The ids come from the same global sets the application loads
 * (`src/main/third-party-emotes.ts`): the showcase shows the emotes chat really displays.
 */
const EMOTES: Record<string, { url: string; source: string }> = {
  Kappa: { url: 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0', source: 'Twitch' },
  LUL: { url: 'https://static-cdn.jtvnw.net/emoticons/v2/425618/default/dark/2.0', source: 'Twitch' },
  PogChamp: { url: 'https://static-cdn.jtvnw.net/emoticons/v2/305954156/default/dark/2.0', source: 'Twitch' },
  Kreygasm: { url: 'https://static-cdn.jtvnw.net/emoticons/v2/41/default/dark/2.0', source: 'Twitch' },
  peepoHappy: { url: 'https://cdn.7tv.app/emote/01GAZ199Z8000FEWHS6AT5QZV0/2x.webp', source: '7TV' },
  Clap: { url: 'https://cdn.7tv.app/emote/01GAM8EFQ00004MXFXAJYKA859/2x.webp', source: '7TV' },
  WAYTOODANK: { url: 'https://cdn.7tv.app/emote/01G98W833R0000BRQD106P0ZNT/2x.webp', source: '7TV' },
  PETPET: { url: 'https://cdn.7tv.app/emote/01FE3XY508000AA32JP519W2EW/2x.webp', source: '7TV' },
  monkaS: { url: 'https://cdn.betterttv.net/emote/56e9f494fff3cc5c35e5287e/2x', source: 'BetterTTV' },
  FeelsGoodMan: { url: 'https://cdn.betterttv.net/emote/566c9fde65dbbdab32ec053e/2x', source: 'BetterTTV' },
  SourPls: { url: 'https://cdn.betterttv.net/emote/566ca38765dbbdab32ec0560/2x', source: 'BetterTTV' },
  CatBag: { url: 'https://cdn.frankerfacez.com/emote/25927/2', source: 'FrankerFaceZ' }
}

/** The affiliate channel seal exists nowhere in the static HTML: it is the only one that has to be copied over. */
const VERIFIED = '<path d="M12 3l7 3v5.5c0 4.3-2.9 7.7-7 9-4.1-1.3-7-4.7-7-9V6Z"/><path d="m9 12 2 2 4-4"/>'

/**
 * The explore view builds its two icons in code, so no `data-icon` span carries them in the
 * page to copy from. Their paths come from `src/renderer/icons.ts`, in the same shell `icon()` uses.
 */
const GLYPHS: Record<string, string> = {
  people: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 1 0 7.8"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'
}
const glyph = (name: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${GLYPHS[name]}</svg>`

/** The signed-in account, shared by both captured screens. */
const ACCOUNT = { login: 'mila_pixel', avatar: 11 }

type Part = string | { emote: string } | { mention: string } | { link: string } | { gif: { url: string; label: string } }
interface DemoMessage {
  user: string
  avatar: number
  color: string
  badges: string[]
  time: string
  parts: Part[]
  own?: boolean
  action?: boolean
  /** The message calls out the signed-in account: the row turns to alert, as in the real channel. */
  mention?: boolean
  system?: boolean
  quote?: { user: string; text: string }
}

/**
 * The demo channel: every line exists to show a real chat capability
 * — emotes, quoted reply, `/me`, mention, system message, message from the signed-in account.
 * Both versions keep the same lines: the capture has to stay comparable from one
 * language to the other, only the text changes.
 */
const CONVERSATIONS: Record<string, DemoMessage[]> = {
  fr: [
    { user: 'pixel_crab', avatar: 1, color: '#d971ff', badges: ['MOD'], time: '22:41', parts: ['ok le visuel vient de changer là 👀 ', { emote: 'peepoHappy' }] },
    { user: 'CroissantFeral', avatar: 5, color: '#f7c867', badges: [], time: '22:42', parts: ['le pain avec les lunettes dans le chat ', { emote: 'LUL' }, ' ', { emote: 'LUL' }] },
    { user: 'xX_Grenouille_Xx', avatar: 2, color: '#78d97a', badges: ['VIP'], time: '22:43', quote: { user: 'pixel_crab', text: 'ok le visuel vient de changer là 👀' }, parts: ['on garde cette boucle, elle est beaucoup trop bien ', { emote: 'PogChamp' }] },
    { user: 'turbo_clio_2004', avatar: 3, color: '#6cb8ff', badges: [], time: '22:44', parts: ['ça part en drum & bass ou je rêve ', { emote: 'monkaS' }] },
    { user: 'dj_marmotte', avatar: 10, color: '#ffb066', badges: ['MOD'], time: '22:45', action: true, parts: ['lance le vote pour le prochain morceau'] },
    { user: 'NekoNoSignal', avatar: 4, color: '#cf8cff', badges: ['SUB'], time: '22:46', parts: ['le synthé qui décroche à la fin, c’est voulu ? ', { emote: 'WAYTOODANK' }] },
    { user: 'ChienPolaire', avatar: 8, color: '#72d7d0', badges: [], time: '22:47', parts: ['WOOOOOO ', { emote: 'SourPls' }, ' ', { emote: 'SourPls' }, ' ', { emote: 'SourPls' }] },
    { user: 'Sombre_Baguette', avatar: 9, color: '#ff756e', badges: [], time: '22:48', parts: ['le pack d’emotes de la chaîne est incroyable ', { emote: 'CatBag' }, ' ', { emote: 'Clap' }] },
    { user: '', avatar: 0, color: '', badges: [], time: '22:48', system: true, parts: ['La chaîne passe en mode lent · 3 secondes entre deux messages.'] },
    { user: 'mila_pixel', avatar: 11, color: '#b9f568', badges: ['SUB'], time: '22:49', own: true, quote: { user: 'NekoNoSignal', text: 'le synthé qui décroche à la fin, c’est voulu ?' }, parts: ['c’est un delay en feedback, je remonte le mix ', { emote: 'Kappa' }] },
    { user: 'ChevalierDuLag', avatar: 7, color: '#d2d1ca', badges: [], time: '22:50', mention: true, parts: [{ mention: '@mila_pixel' }, ' tu repartages le preset après le live ? ', { emote: 'FeelsGoodMan' }] },
    { user: 'mila_pixel', avatar: 11, color: '#b9f568', badges: ['SUB'], time: '22:51', own: true, parts: ['le preset est là si ça intéresse quelqu’un : ', { link: 'https://studio-nova.fr/patch-42' }] },
    { user: 'cat_on_keyboard', avatar: 0, color: '#f49d70', badges: [], time: '22:52', parts: ['mrrrrp ', { gif: { url: 'https://media.giphy.com/media/vFKqnCdLPNOKc/giphy.gif', label: '[chaton qui roule GIF]' } }] }
  ],
  en: [
    { user: 'pixel_crab', avatar: 1, color: '#d971ff', badges: ['MOD'], time: '22:41', parts: ['ok the visuals just changed there 👀 ', { emote: 'peepoHappy' }] },
    { user: 'CroissantFeral', avatar: 5, color: '#f7c867', badges: [], time: '22:42', parts: ['the bread with glasses in chat ', { emote: 'LUL' }, ' ', { emote: 'LUL' }] },
    { user: 'xX_Grenouille_Xx', avatar: 2, color: '#78d97a', badges: ['VIP'], time: '22:43', quote: { user: 'pixel_crab', text: 'ok the visuals just changed there 👀' }, parts: ['keep that loop, it is way too good ', { emote: 'PogChamp' }] },
    { user: 'turbo_clio_2004', avatar: 3, color: '#6cb8ff', badges: [], time: '22:44', parts: ['is this going drum & bass or am I dreaming ', { emote: 'monkaS' }] },
    { user: 'dj_marmotte', avatar: 10, color: '#ffb066', badges: ['MOD'], time: '22:45', action: true, parts: ['starts the vote for the next track'] },
    { user: 'NekoNoSignal', avatar: 4, color: '#cf8cff', badges: ['SUB'], time: '22:46', parts: ['the synth drifting at the end, is that on purpose? ', { emote: 'WAYTOODANK' }] },
    { user: 'ChienPolaire', avatar: 8, color: '#72d7d0', badges: [], time: '22:47', parts: ['WOOOOOO ', { emote: 'SourPls' }, ' ', { emote: 'SourPls' }, ' ', { emote: 'SourPls' }] },
    { user: 'Sombre_Baguette', avatar: 9, color: '#ff756e', badges: [], time: '22:48', parts: ['this channel emote pack is unreal ', { emote: 'CatBag' }, ' ', { emote: 'Clap' }] },
    { user: '', avatar: 0, color: '', badges: [], time: '22:48', system: true, parts: ['The channel switched to slow mode · 3 seconds between messages.'] },
    { user: 'mila_pixel', avatar: 11, color: '#b9f568', badges: ['SUB'], time: '22:49', own: true, quote: { user: 'NekoNoSignal', text: 'the synth drifting at the end, is that on purpose?' }, parts: ['it is a feedback delay, I am bringing the mix back up ', { emote: 'Kappa' }] },
    { user: 'ChevalierDuLag', avatar: 7, color: '#d2d1ca', badges: [], time: '22:50', mention: true, parts: [{ mention: '@mila_pixel' }, ' will you share the preset after the stream? ', { emote: 'FeelsGoodMan' }] },
    { user: 'mila_pixel', avatar: 11, color: '#b9f568', badges: ['SUB'], time: '22:51', own: true, parts: ['the preset is here if anyone wants it: ', { link: 'https://studio-nova.fr/patch-42' }] },
    { user: 'cat_on_keyboard', avatar: 0, color: '#f49d70', badges: [], time: '22:52', parts: ['mrrrrp ', { gif: { url: 'https://media.giphy.com/media/vFKqnCdLPNOKc/giphy.gif', label: '[rolling kitten GIF]' } }] }
  ]
}

/** The sidebar channels: live stream, unread, mentions in alert and the active channel. */
const ROOMS = [
  { channel: 'studio_nova', avatar: 2, live: 'true', unread: '', mentions: false },
  { channel: 'lofi_garden', avatar: 6, live: 'true', unread: '3', mentions: true },
  { channel: 'speedrun_fr', avatar: 1, live: 'true', unread: '37', mentions: false },
  { channel: 'le_chat_du_coin', avatar: 8, live: 'false', unread: '99+', mentions: false },
  { channel: 'atelier_synthe', avatar: 3, live: 'false', unread: '', mentions: false }
]

/** The profile card, opened on a channel regular, and the interface chrome. */
const CARD_FR = {
  login: 'xX_Grenouille_Xx', color: '#78d97a',
  bio: 'Karaoké du jeudi, sessions modulaires le week-end. Toujours une boucle de trop.',
  live: 'En direct · 862 spectateurs',
  title: 'Session karaoké : vos pires morceaux, mes pires notes.',
  stats: [['4,2 k', 'Followers'], ['2021', 'Sur Twitch'], ['18', 'Messages ici']] as [string, string][]
}
const CARD_EN = {
  login: 'xX_Grenouille_Xx', color: '#78d97a',
  bio: 'Thursday karaoke, modular sessions at the weekend. Always one loop too many.',
  live: 'Live · 862 viewers',
  title: 'Karaoke session: your worst tracks, my worst notes.',
  stats: [['4.2K', 'Followers'], ['2021', 'On Twitch'], ['18', 'Messages here']] as [string, string][]
}

/** The chrome the capture sets itself: it has to speak the same language as the app. */
const CHROME = {
  fr: {
    accountDescription: 'Compte Twitch connecté',
    connection: 'Chat connecté',
    channelSubtitle: '42 781 PERSONNES · MUSIQUE & CRÉATION',
    messageCount: '327 messages',
    technicalStatus: 'IRC / TLS <i></i> VIDÉO HLS',
    liveBadge: '● EN DIRECT',
    liveTag: 'EN DIRECT',
    modes: ['Lent 3 s', 'Followers'],
    cardActions: [['chat', 'Mentionner'], ['hash', 'Rejoindre'], ['external', 'Twitch']] as [string, string][],
    draft: '@cat_on_keyboard mrrrp aussi, je garde la boucle pour le prochain live :musical_note:',
    composerPlaceholder: 'Écrire dans #studio_nova',
    idle: ['radio_ancienne', 'kraken_du_dimanche'],
    gateTitle: '#studio_nova n’accepte que les messages des followers.',
    gateDetail: 'Cette chaîne n’accepte que les comptes qui la suivent depuis au moins 10 minutes.',
    followedSummary: 'Vos chaînes suivies, celles en direct d’abord.',
    offline: ['pain_perdu_tv', 'atelier_synthe', 'le_chat_du_coin', 'nuit_blanche', 'cafe_serre']
  },
  en: {
    accountDescription: 'Twitch account connected',
    connection: 'Chat connected',
    channelSubtitle: '42,781 PEOPLE · MUSIC & CREATION',
    messageCount: '327 messages',
    technicalStatus: 'IRC / TLS <i></i> HLS VIDEO',
    liveBadge: '● LIVE',
    liveTag: 'LIVE',
    modes: ['Slow 3s', 'Followers'],
    cardActions: [['chat', 'Mention'], ['hash', 'Join'], ['external', 'Twitch']] as [string, string][],
    draft: '@cat_on_keyboard mrrrp too, keeping the loop for the next stream :musical_note:',
    composerPlaceholder: 'Write in #studio_nova',
    idle: ['radio_ancienne', 'kraken_du_dimanche'],
    gateTitle: '#studio_nova only accepts messages from followers.',
    gateDetail: 'This channel only accepts accounts that have followed it for at least 10 minutes.',
    followedSummary: 'The channels you follow, the live ones first.',
    offline: ['pain_perdu_tv', 'atelier_synthe', 'le_chat_du_coin', 'nuit_blanche', 'cafe_serre']
  }
}

interface DemoStream {
  channel: string
  avatar: number
  /** Already formatted: the landing must not depend on the locale of the machine capturing it. */
  viewers: string
  uptime: string
  game: string
  title: string
  tags: string[]
  joined?: boolean
}

/**
 * The explore view: what the catalog returns for the most watched channels.
 * The single demo frame is cropped and shifted per card, so six previews come out
 * distinct without inventing six stream contents.
 */
const DISCOVERY: Record<string, DemoStream[]> = {
  fr: [
    { channel: 'studio_nova', avatar: 2, viewers: '42,7 k', uptime: '3 h 12', game: 'Musique', title: 'Session modulaire : on construit un patch en direct', tags: ['Français', 'Musique', 'Détente'], joined: true },
    { channel: 'lofi_garden', avatar: 6, viewers: '8,4 k', uptime: '11 h 40', game: 'Musique', title: 'lofi pour réviser · la playlist du soir', tags: ['Français', 'Chill'], joined: true },
    { channel: 'speedrun_fr', avatar: 1, viewers: '5,1 k', uptime: '1 h 08', game: 'Hollow Knight', title: 'Any% jusqu’au PB ou jusqu’à l’aube', tags: ['Français', 'Speedrun'] },
    { channel: 'atelier_synthe', avatar: 3, viewers: '2,3 k', uptime: '45 min', game: 'Musique', title: 'On répare un Juno-106 à l’oscilloscope', tags: ['Français', 'Bricolage'] },
    { channel: 'le_chat_du_coin', avatar: 8, viewers: '1,9 k', uptime: '2 h 30', game: 'Just Chatting', title: 'Café, courrier des auditeurs, questions bêtes', tags: ['Français', 'Discussion'] },
    { channel: 'pixel_crab', avatar: 1, viewers: '860', uptime: '22 min', game: 'Art', title: 'Pixel art : on finit le tileset de la grotte', tags: ['Français', 'Création'] }
  ],
  en: [
    { channel: 'studio_nova', avatar: 2, viewers: '42.7K', uptime: '3h 12', game: 'Music', title: 'Modular session: building a patch live', tags: ['English', 'Music', 'Chill'], joined: true },
    { channel: 'lofi_garden', avatar: 6, viewers: '8.4K', uptime: '11h 40', game: 'Music', title: 'lofi to study to · tonight’s playlist', tags: ['English', 'Chill'], joined: true },
    { channel: 'speedrun_fr', avatar: 1, viewers: '5.1K', uptime: '1h 08', game: 'Hollow Knight', title: 'Any% until the PB or until sunrise', tags: ['English', 'Speedrun'] },
    { channel: 'atelier_synthe', avatar: 3, viewers: '2.3K', uptime: '45m', game: 'Music', title: 'Fixing a Juno-106 with an oscilloscope', tags: ['English', 'Repair'] },
    { channel: 'le_chat_du_coin', avatar: 8, viewers: '1.9K', uptime: '2h 30', game: 'Just Chatting', title: 'Coffee, listener mail, silly questions', tags: ['English', 'Talk'] },
    { channel: 'pixel_crab', avatar: 1, viewers: '860', uptime: '22m', game: 'Art', title: 'Pixel art: finishing the cave tileset', tags: ['English', 'Creative'] }
  ]
}

/** The emote picker, frozen on the channel tab: the sets the app really merges. */
const PICKER = {
  fr: {
    tabs: ['Récentes', 'La chaîne', 'Twitch', 'Smileys', 'Animaux', 'Nourriture'],
    active: 'La chaîne',
    groups: [
      { title: 'EMOTES DE LA CHAÎNE', codes: ['peepoHappy', 'Clap', 'WAYTOODANK', 'PETPET', 'monkaS', 'FeelsGoodMan', 'SourPls', 'CatBag'] },
      { title: 'EMOTES TWITCH', codes: ['Kappa', 'LUL', 'PogChamp', 'Kreygasm'] }
    ],
    emojis: ['🎵', '🎤', '🎧', '🥁', '🎹', '✨', '🔥', '💚'],
    emojiTitle: 'EMOJIS',
    hint: 'Cliquez pour insérer, la fenêtre reste ouverte.',
    search: 'Rechercher une emote',
    preview: 'peepoHappy · 7TV'
  },
  en: {
    tabs: ['Recent', 'This channel', 'Twitch', 'Smileys', 'Animals', 'Food'],
    active: 'This channel',
    groups: [
      { title: 'CHANNEL EMOTES', codes: ['peepoHappy', 'Clap', 'WAYTOODANK', 'PETPET', 'monkaS', 'FeelsGoodMan', 'SourPls', 'CatBag'] },
      { title: 'TWITCH EMOTES', codes: ['Kappa', 'LUL', 'PogChamp', 'Kreygasm'] }
    ],
    emojis: ['🎵', '🎤', '🎧', '🥁', '🎹', '✨', '🔥', '💚'],
    emojiTitle: 'EMOJIS',
    hint: 'Click to insert, the panel stays open.',
    search: 'Search an emote',
    preview: 'peepoHappy · 7TV'
  }
}

/** The explore view's own chrome, and the wording of the detached player. */
const VIEWS = {
  fr: {
    discoverSummary: '6 chaînes en direct · classées par audience',
    freshness: 'Il y a 30 s',
    allCategories: 'Toutes',
    joined: 'Ouvrir',
    join: 'Rejoindre',
    detachedStatus: 'EN DIRECT',
    detachedNote: 'La vidéo joue dans sa propre fenêtre',
    titlebarDiscover: 'EXPLORATION DES CHAÎNES',
    titlebarSettings: 'RÉGLAGES DE L’APPLICATION'
  },
  en: {
    discoverSummary: '6 channels live · sorted by audience',
    freshness: '30s ago',
    allCategories: 'All',
    joined: 'Open',
    join: 'Join',
    detachedStatus: 'LIVE',
    detachedNote: 'The video plays in its own window',
    titlebarDiscover: 'BROWSING CHANNELS',
    titlebarSettings: 'APPLICATION SETTINGS'
  }
}

const MESSAGES = CONVERSATIONS[locale]!
const CARD = locale === 'en' ? CARD_EN : CARD_FR
const TEXT = CHROME[locale]
const STREAMS = DISCOVERY[locale]!
const PICKER_TEXT = PICKER[locale]
const VIEW_TEXT = VIEWS[locale]

/** The offline list heading, word for word the one in the application's catalog. */
const offlineHeading = (count: number) => locale === 'fr'
  ? `HORS LIGNE · ${count} CHAÎNE${count > 1 ? 'S' : ''}`
  : `OFFLINE · ${count} CHANNEL${count === 1 ? '' : 'S'}`

const app = await electron.launch({ args: ['.'], env: { ...process.env, TWICHAT_LOCALE: locale, TWICHAT_TEST_DATA: resolve(tmpdir(), `twichat-landing-${locale}-${process.pid}`) } })
try {
  const page = await app.firstWindow()
  // A capture staged on a page that is throwing would freeze a half-built screen: say so instead.
  page.on('pageerror', error => { throw new Error(`The application threw while staging a capture: ${error.message}`) })
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => document.body.dataset.ready === 'true')

  /**
   * One shot, in both themes. The client follows the system theme: without this explicit
   * switch, the look of the machine generating the capture would decide the landing's own.
   */
  const shoot = async (name: string) => {
    for (const theme of ['dark', 'light'] as const) {
      // The name carries the language: the landing serves the capture of the page it displays.
      const png = resolve(assets, `${name}${theme === 'light' ? '-light' : ''}.${locale}.png`)
      const webp = png.replace(/\.png$/, '.webp')
      await page.evaluate(value => { document.documentElement.dataset.theme = value }, theme)
      // A theme that fails to apply would give two near-identical captures, signaling nothing.
      const surface = await page.evaluate(() => getComputedStyle(document.querySelector('.sidebar')!).backgroundColor)
      const level = Number(surface.match(/\d+/)?.[0] ?? NaN)
      if (theme === 'light' ? !(level > 200) : !(level < 60)) throw new Error(`Theme ${theme} not applied: the sidebar is ${surface}.`)
      await freezeVideo()
      await page.screenshot({ path: png })
      await encode(png, webp)
    }
  }

  const freezeVideo = async () => {
    await page.evaluate(label => {
      const one = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!
      one('#video-placeholder').hidden = true
      one('#video-error').hidden = true
      const status = one('#player-status')
      status.textContent = label
      status.className = 'quiet-tag playing'
      status.setAttribute('style', 'color:var(--lime);border-color:var(--g47)')
    }, TEXT.liveTag)
  }

  /** The landing serves the WebP: it is re-encoded from the PNG beside it, so the two never drift. */
  const encode = async (png: string, webp: string) => {
    const capture = `data:image/png;base64,${(await readFile(png)).toString('base64')}`
    const encoded = await page.evaluate(async (source: string) => {
      const image = new Image()
      image.src = source
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      canvas.getContext('2d')!.drawImage(image, 0, 0)
      return canvas.toDataURL('image/webp', 0.82).split(',')[1]
    }, capture)
    await writeFile(webp, Buffer.from(encoded, 'base64'))
    console.log(png)
    console.log(webp)
  }

  /**
   * The detached video is two windows at once, and no screenshot holds both. The room is
   * captured as usual, the video window on its own, and the second is laid over the first
   * where it actually floats: above the dock it just left.
   */
  const shootDetached = async (name: string, player: Awaited<ReturnType<typeof app.firstWindow>>) => {
    for (const theme of ['dark', 'light'] as const) {
      const png = resolve(assets, `${name}${theme === 'light' ? '-light' : ''}.${locale}.png`)
      for (const surface of [page, player]) await surface.evaluate(value => { document.documentElement.dataset.theme = value }, theme)
      const shade = await page.evaluate(() => getComputedStyle(document.querySelector('.sidebar')!).backgroundColor)
      const level = Number(shade.match(/\d+/)?.[0] ?? NaN)
      if (theme === 'light' ? !(level > 200) : !(level < 60)) throw new Error(`Theme ${theme} not applied: the sidebar is ${shade}.`)

      await freezeVideo()
      await page.evaluate(label => {
        const tag = document.querySelector<HTMLElement>('#detached-panel-status')!
        tag.textContent = label
        tag.className = 'quiet-tag playing'; tag.setAttribute('style', 'color:var(--lime);border-color:var(--g47)')
      }, VIEW_TEXT.detachedStatus)
      const room = (await page.screenshot()).toString('base64')
      const floating = (await player.screenshot()).toString('base64')
      const composed = await page.evaluate(async ({ room, floating }) => {
        const load = async (data: string) => { const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode(); return image }
        const base = await load(room)
        const overlay = await load(floating)
        const canvas = document.createElement('canvas')
        canvas.width = base.naturalWidth
        canvas.height = base.naturalHeight
        const paint = canvas.getContext('2d')!
        paint.drawImage(base, 0, 0)
        // Bottom right, over the dock: the corner the window opens onto, and the one place
        // where it hides no message.
        const x = canvas.width - overlay.naturalWidth - 46
        const y = canvas.height - overlay.naturalHeight - 52
        paint.shadowColor = 'rgba(0, 0, 0, .55)'
        paint.shadowBlur = 48
        paint.shadowOffsetY = 16
        paint.drawImage(overlay, x, y)
        return canvas.toDataURL('image/png').split(',')[1]
      }, { room, floating })
      await writeFile(png, Buffer.from(composed, 'base64'))
      await encode(png, png.replace(/\.png$/, '.webp'))
    }
  }

  // Navigate by id: the interface texts change far more often than the markup does.
  await page.locator('#anonymous-session').click()
  await page.waitForSelector('#app:not([hidden])')
  // Final size first: message heights are measured at the width of the capture.
  await page.setViewportSize({ width: 1320, height: 880 })
  // Let the anonymous IRC connection settle before freezing the interface.
  await page.waitForTimeout(1200)

  // First screen: the welcome of a signed-in account that has not joined a channel yet.
  await page.evaluate(({ account, avatar, chrome }) => {
    const one = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!
    const style = document.createElement('style')
    // Theme fades would outlast the capture: frozen, both themes come out sharp.
    style.textContent = '*,*::before,*::after{transition-duration:0s!important;animation-duration:0s!important}.demo-live{position:absolute;z-index:4;left:8px;top:8px;padding:4px 7px;background:#db3e48;color:white;font-size:8px;font-weight:800;letter-spacing:.1em}.demo-viewers{position:absolute;z-index:4;right:8px;top:8px;padding:4px 7px;background:rgba(8,9,9,.76);color:#eee;font-size:8px}.demo-controls{position:absolute;z-index:4;left:0;right:0;bottom:0;height:38px;padding:17px 9px 0;background:linear-gradient(transparent,rgba(0,0,0,.8));color:white;font-size:9px}.demo-controls span{float:right;color:#cfd1cb}.message-avatar.demo,.account>.avatar.demo-account,.room-avatar.demo-room,.user-card-avatar.demo-card{border-radius:2px;background-color:var(--n24,#242727)}'
    document.head.append(style)
    one('#account-name').textContent = account
    one('#account-description').textContent = chrome.accountDescription
    const accountAvatar = one<HTMLElement>('#account-button .avatar')
    accountAvatar.className = 'avatar demo-account'; accountAvatar.innerHTML = ''; accountAvatar.setAttribute('style', avatar)
    one('#connection-label').textContent = chrome.connection
    one('#connection-dot').className = 'status-dot connected'
  }, { account: ACCOUNT.login, avatar: avatarStyle(ACCOUNT.avatar), chrome: TEXT })
  await shoot('app-welcome')

  // Second screen: the channel, once the evening is well under way.
  await page.locator('#welcome-add').click()
  await page.locator('#channel-input').fill('studio_nova')
  await page.locator('#join-form button[type=submit]').click()
  await page.waitForSelector('#room-view:not([hidden])')
  await page.waitForTimeout(1200)
  await page.evaluate(() => window.twichat.stopStream())

  await page.evaluate(({ stream, emotes, messages, rooms, idle, card, verified, account, chrome }) => {
    const one = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!
    // The renderer icons are already hydrated in the page: copy them rather than duplicate their paths.
    const iconOf = (name: string) => {
      const source = document.querySelector(`[data-icon="${name}"] svg`)
      if (!source) return ''
      const holder = document.createElement('div'); holder.append(source.cloneNode(true))
      return holder.innerHTML
    }

    one('#channel-title').textContent = 'studio_nova'
    one('#channel-subtitle').textContent = chrome.channelSubtitle
    one('#message-count').textContent = chrome.messageCount
    one('#chat-empty').hidden = true
    one('#technical-status').innerHTML = chrome.technicalStatus

    // The signed-in account's own channel lives above the followed rooms.
    one('#own-channel-block').hidden = false
    const ownAvatar = one<HTMLElement>('#own-channel .room-avatar')
    ownAvatar.className = 'room-avatar demo-room'; ownAvatar.setAttribute('style', account.avatar)
    one('#own-channel .room-name').textContent = account.login
    one('#own-channel .room-live').dataset.live = 'false'

    const roomList = one('#rooms'); roomList.replaceChildren()
    rooms.forEach((room, index) => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'room-button'
      button.dataset.channel = room.channel; button.setAttribute('aria-current', String(index === 0))
      const image = document.createElement('span'); image.className = 'room-avatar demo-room'; image.setAttribute('style', room.avatar)
      const label = document.createElement('span'); label.className = 'room-name'; label.textContent = room.channel
      const live = document.createElement('span'); live.className = 'room-live'; live.dataset.live = room.live
      button.append(image, label, live)
      if (room.unread) { const count = document.createElement('span'); count.className = `unread${room.mentions ? ' mentions' : ''}`; count.textContent = room.unread; button.append(count) }
      roomList.append(button)
    })
    // Les chaînes sans activité depuis un moment descendent dans leur propre section, dépliée ici.
    one('#idle-block').hidden = false
    one('#idle-count').textContent = String(idle.length)
    one('#idle-toggle').setAttribute('aria-expanded', 'true')
    const idleNav = one('#idle-rooms'); idleNav.hidden = false; idleNav.replaceChildren()
    idle.forEach(({ channel }, index) => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'room-button'
      button.dataset.channel = channel
      const image = document.createElement('span'); image.className = 'room-avatar demo-room'; image.setAttribute('style', idle[index]!.avatar)
      const label = document.createElement('span'); label.className = 'room-name'; label.textContent = channel
      const live = document.createElement('span'); live.className = 'room-live'; live.dataset.live = 'false'
      button.append(image, label, live)
      idleNav.append(button)
    })
    one('#room-count').textContent = String(rooms.length + idle.length)
    one('#sidebar-empty').hidden = true

    // The room modes, as ROOMSTATE delivers them: they sit below the dock's fold,
    // so it is the chat's system line that tells the slow mode inside the captured frame.
    const modes = one('#room-modes'); modes.replaceChildren()
    for (const label of chrome.modes) { const tag = document.createElement('span'); tag.className = 'mode-tag'; tag.textContent = label; modes.append(tag) }

    const space = one('#virtual-space'); space.replaceChildren()
    const rows: HTMLElement[] = []
    for (const message of messages) {
      const row = document.createElement('article')
      row.className = `message${message.action ? ' action' : ''}${message.own ? ' own' : ''}${message.system ? ' system' : ''}${message.mention ? ' mention' : ''}`
      const avatar = document.createElement('span'); avatar.className = 'message-avatar demo'
      if (!message.system) avatar.setAttribute('style', message.avatar)
      const main = document.createElement('div'); main.className = 'message-main'
      if (message.quote) {
        const quote = document.createElement('button'); quote.type = 'button'; quote.className = 'message-quote'; quote.tabIndex = -1
        const who = document.createElement('span'); who.className = 'message-quote-user'; who.textContent = message.quote.user
        const said = document.createElement('span'); said.className = 'message-quote-text'; said.textContent = message.quote.text
        quote.append(who, said); main.append(quote)
      }
      const text = document.createElement('p'); text.className = 'message-text'
      for (const part of message.parts) {
        if (typeof part === 'string') { text.append(document.createTextNode(part)); continue }
        if ('mention' in part) {
          const marked = document.createElement('b'); marked.className = 'message-mention'; marked.textContent = part.mention
          text.append(marked); continue
        }
        if ('link' in part) {
          const link = document.createElement('a'); link.className = 'message-link'; link.href = part.link
          link.textContent = part.link; link.title = part.link; link.rel = 'noreferrer noopener'; link.tabIndex = -1
          text.append(link); continue
        }
        if ('gif' in part) {
          // The address goes in whole, as Twitch hands it over from the GIPHY keyboard.
          const gif = document.createElement('img'); gif.className = 'message-gif'
          gif.alt = part.gif.label; gif.title = `${part.gif.label} · GIPHY`; gif.decoding = 'async'
          gif.src = part.gif.url
          text.append(gif); continue
        }
        const emote = emotes[part.emote]
        const image = document.createElement('img')
        // An empty `alt` is hidden by the stylesheet: the showcase keeps the emote code.
        image.className = 'message-emote'; image.alt = part.emote; image.title = `${part.emote} · ${emote.source}`
        image.decoding = 'async'; image.src = emote.url
        text.append(image)
      }
      if (message.system) { main.append(text); row.append(avatar, main) }
      else {
        const meta = document.createElement('div'); meta.className = 'message-meta'
        const user = document.createElement('span'); user.className = 'message-user'; user.textContent = message.user; user.style.color = message.color
        meta.append(user)
        for (const badgeName of message.badges) { const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = badgeName; meta.append(badge) }
        const time = document.createElement('time'); time.className = 'message-time'; time.textContent = message.time; meta.append(time)
        main.append(meta, text); row.append(avatar, main)
      }
      space.append(row); rows.push(row)
    }
    // Second pass: quotes and emotes change the row heights, and a fixed step would make them overlap.
    let top = 0
    for (const row of rows) { row.style.transform = `translateY(${top}px)`; top += row.offsetHeight }
    space.style.height = `${top}px`
    const log = one('#chat-log'); log.scrollTop = log.scrollHeight

    // The profile card: what the room knows about a regular, without leaving the conversation.
    const cardElement = one('#user-card'); cardElement.replaceChildren(); cardElement.hidden = false
    const head = document.createElement('div'); head.className = 'user-card-head'
    const cardAuthor = messages.findIndex(message => message.user === card.login)
    if (cardAuthor < 0) throw new Error(`No message from ${card.login} in the demo conversation.`)
    const cardAvatar = document.createElement('span'); cardAvatar.className = 'user-card-avatar demo-card'; cardAvatar.setAttribute('style', messages[cardAuthor].avatar)
    const identity = document.createElement('div'); identity.className = 'user-card-identity'
    const name = document.createElement('div'); name.className = 'user-card-name'
    const label = document.createElement('span'); label.textContent = card.login; label.style.color = card.color
    const seal = document.createElement('span'); seal.className = 'user-card-seal'
    seal.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${verified}</svg>`
    name.append(label, seal)
    const handle = document.createElement('p'); handle.className = 'user-card-login'; handle.textContent = `@${card.login}`
    const live = document.createElement('span'); live.className = 'user-card-live'
    live.append(document.createElement('i')); live.append(card.live)
    identity.append(name, handle, live)
    head.append(cardAvatar, identity)
    const bio = document.createElement('p'); bio.className = 'user-card-bio'; bio.textContent = card.bio
    const stats = document.createElement('div'); stats.className = 'user-card-stats'
    for (const [value, caption] of card.stats) {
      const stat = document.createElement('div'); stat.className = 'user-card-stat'
      const figure = document.createElement('strong'); figure.textContent = value
      const legend = document.createElement('span'); legend.textContent = caption
      stat.append(figure, legend); stats.append(stat)
    }
    const title = document.createElement('p'); title.className = 'user-card-title'; title.textContent = card.title
    const actions = document.createElement('div'); actions.className = 'user-card-actions'
    for (const [name, label] of chrome.cardActions) {
      const button = document.createElement('button'); button.type = 'button'; button.innerHTML = `${iconOf(name)}${label}`
      actions.append(button)
    }
    cardElement.append(head, bio, stats, title, actions)
    // Anchored on its author's message, as it is when hovering the nickname.
    const anchor = rows[cardAuthor].getBoundingClientRect()
    cardElement.style.left = `${Math.round(anchor.left + 380)}px`
    cardElement.style.top = `${Math.round(anchor.top - 6)}px`

    // The placeholder is hidden, not removed: the player still reaches for it, and taking the
    // video out of the room later would throw on a stage emptied here.
    const stage = one('#video-stage'); one('#video-placeholder').hidden = true
    stage.style.background = `url(${stream}) center / cover no-repeat`
    const badge = document.createElement('span'); badge.className = 'demo-live'; badge.textContent = chrome.liveBadge
    const viewers = document.createElement('span'); viewers.className = 'demo-viewers'; viewers.textContent = '42,7 k'
    const controls = document.createElement('div'); controls.className = 'demo-controls'; controls.innerHTML = '▶ &nbsp; 🔊 <span>⚙ &nbsp; ⛶</span>'
    stage.append(badge, viewers, controls)
    one('#player-channel').textContent = '# studio_nova'
    const status = one('#player-status'); status.textContent = chrome.liveTag; status.className = 'quiet-tag playing'; status.setAttribute('style', 'color:var(--lime);border-color:var(--g47)')
    one<HTMLSelectElement>('#quality').value = '720p60,720p,best'
    one('#video-error').hidden = true
    one<HTMLButtonElement>('#stop-stream').hidden = false
    one<HTMLButtonElement>('#fullscreen-stream').disabled = false
    one<HTMLButtonElement>('#fullscreen-stream').removeAttribute('disabled')

    // The composer, as for a signed-in account: a reply under way and a draft waiting.
    one('#composer-reply').hidden = false
    one('#composer-reply-user').textContent = 'cat_on_keyboard'
    one('#composer-reply-text').textContent = ' · mrrrrp mrrrrp mrrrrp'
    one<HTMLButtonElement>('#emote-button').disabled = false
    one('#composer-login').hidden = true
    one('#composer-hint').hidden = false
  }, {
    stream, emotes: EMOTES, verified: VERIFIED, card: CARD, chrome: TEXT,
    account: { login: ACCOUNT.login, avatar: avatarStyle(ACCOUNT.avatar) },
    messages: MESSAGES.map(message => ({ ...message, avatar: avatarStyle(message.avatar) })),
    rooms: ROOMS.map(room => ({ ...room, avatar: avatarStyle(room.avatar) })),
    idle: TEXT.idle.map((channel, index) => ({ channel, avatar: avatarStyle(index === 0 ? 7 : 10) }))
  })

  // The draft goes through the real composer: mention and emoji coloring is the application's own.
  await page.evaluate(chrome => {
    const input = document.querySelector<HTMLTextAreaElement>('#composer')!
    input.disabled = false
    input.placeholder = chrome.composerPlaceholder
    input.value = chrome.draft
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, TEXT)
  const draft = await page.evaluate(() => ({
    mention: document.querySelectorAll('#composer-mirror .tk-mention').length,
    emoji: document.querySelectorAll('#composer-mirror .tk-emoji').length,
    flagged: document.querySelectorAll('#composer-mirror .tk-invalid, #composer-mirror .tk-overflow').length,
    send: !document.querySelector<HTMLButtonElement>('#send-message')!.disabled
  }))
  if (!draft.mention || !draft.emoji || draft.flagged || !draft.send) throw new Error(`Invalid composer draft: ${JSON.stringify(draft)}`)

  // An emote missing from the CDN would go unnoticed and freeze a broken capture onto the landing.
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll<HTMLImageElement>('.message-emote, .message-gif')]
    return images.length > 0 && images.every(image => image.complete)
  }, undefined, { timeout: 20000 })
  const broken = await page.evaluate(() => [...document.querySelectorAll<HTMLImageElement>('.message-emote, .message-gif')].filter(image => !image.naturalWidth).map(image => image.src))
  if (broken.length) throw new Error(`Emotes failed to load: ${broken.join(', ')}`)

  // A GIF has no size before it loads: the rows were measured without it. Now that every image
  // is there, the log is laid out a second time — otherwise the last message stays cut off.
  await page.evaluate(login => {
    const space = document.querySelector<HTMLElement>('#virtual-space')!
    let top = 0
    for (const row of space.children) {
      const element = row as HTMLElement
      element.style.transform = `translateY(${top}px)`
      top += element.offsetHeight
    }
    space.style.height = `${top}px`
    const log = document.querySelector<HTMLElement>('#chat-log')!
    log.scrollTop = log.scrollHeight

    // The card follows its author's message, which the relayout has just moved. Kept inside the
    // log: anchored to a row that scrolled out, it would float over the header.
    const card = document.querySelector<HTMLElement>('#user-card')!
    const author = [...space.querySelectorAll<HTMLElement>('.message-user')].find(user => user.textContent === login)
    const row = author?.closest<HTMLElement>('.message')
    if (!row) return
    const bounds = row.getBoundingClientRect()
    const view = log.getBoundingClientRect()
    card.style.left = `${Math.round(bounds.left + 380)}px`
    card.style.top = `${Math.round(Math.min(Math.max(bounds.top - 6, view.top + 10), view.bottom - card.offsetHeight - 10))}px`
  }, CARD.login)

  await shoot('app-chat')

  // Screen: the followers-only gate. Twitch refuses the message before it is sent, so the
  // composer says the rule and offers the follow rather than letting a message fail.
  await page.evaluate(chrome => {
    const one = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!
    one('#composer-reply').hidden = true
    const input = one<HTMLTextAreaElement>('#composer')
    input.value = ''
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.disabled = true
    input.placeholder = ''
    one<HTMLButtonElement>('#emote-button').disabled = true
    one('#composer-gate').hidden = false
    one('#composer-gate-title').textContent = chrome.gateTitle
    one('#composer-gate-detail').textContent = chrome.gateDetail
  }, TEXT)
  await shoot('app-gate')

  // The gate steps aside: the screens that follow show the composer as a signed-in account has it.
  await page.evaluate(chrome => {
    const one = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!
    one('#composer-gate').hidden = true
    one('#composer-reply').hidden = false
    const input = one<HTMLTextAreaElement>('#composer')
    input.disabled = false
    input.placeholder = chrome.composerPlaceholder
    input.value = chrome.draft
    input.dispatchEvent(new Event('input', { bubbles: true }))
    one<HTMLButtonElement>('#emote-button').disabled = false
  }, TEXT)

  // Third screen: the emote picker. Twitch, 7TV, BetterTTV and FrankerFaceZ land in one grid,
  // which is the whole point of the panel: the channel's emotes, wherever they come from.
  await page.evaluate(({ emotes, picker }) => {
    const one = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!
    one('#user-card').hidden = true
    one('#emote-picker').hidden = false
    one('#emote-button').setAttribute('aria-expanded', 'true')
    one<HTMLInputElement>('#emote-search').placeholder = picker.search

    const tabs = one('#picker-tabs'); tabs.replaceChildren()
    for (const label of picker.tabs) {
      const tab = document.createElement('button'); tab.type = 'button'; tab.className = 'picker-tab'
      tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(label === picker.active))
      tab.textContent = label
      tabs.append(tab)
    }

    const results = one('#emote-results'); results.replaceChildren()
    const group = (title: string, cells: { label: string; url?: string }[]) => {
      const heading = document.createElement('span'); heading.className = 'picker-group'; heading.textContent = title
      const grid = document.createElement('div'); grid.className = 'picker-grid'
      for (const cell of cells) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'picker-item'
        button.tabIndex = -1; button.title = cell.label
        button.setAttribute('role', 'option'); button.setAttribute('aria-label', cell.label)
        if (cell.url) {
          const image = document.createElement('img')
          image.src = cell.url; image.alt = cell.label; image.decoding = 'async'
          button.append(image)
        } else button.textContent = cell.label
        grid.append(button)
      }
      results.append(heading, grid)
    }
    for (const set of picker.groups) group(set.title, set.codes.map(code => ({ label: code, url: emotes[code]!.url })))
    group(picker.emojiTitle, picker.emojis.map(emoji => ({ label: emoji })))

    // The footer previews whatever the pointer is on: here, the first emote of the grid.
    const preview = one('#emote-preview'); preview.replaceChildren()
    const sample = document.createElement('img'); sample.src = emotes.peepoHappy!.url; sample.alt = ''
    const name = document.createElement('b'); name.textContent = 'peepoHappy'
    preview.append(sample, name, document.createTextNode(' · 7TV'))
  }, { emotes: EMOTES, picker: PICKER_TEXT })
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll<HTMLImageElement>('#emote-picker img')]
    return images.length > 0 && images.every(image => image.complete)
  }, undefined, { timeout: 20000 })
  const emptyCells = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLImageElement>('#emote-picker img')].filter(image => !image.naturalWidth).map(image => image.src))
  if (emptyCells.length) throw new Error(`Picker emotes failed to load: ${emptyCells.join(', ')}`)
  await shoot('app-emotes')

  // Fourth screen: the video in its own window. It is taken here, while the room is still the
  // open view: the application only detaches from the room, and refuses from anywhere else.
  await page.evaluate(() => { document.querySelector<HTMLElement>('#emote-picker')!.hidden = true })
  // The detach goes through the real button: the dock, the panel and the second window all
  // reach their state the way they do for someone clicking it, with nothing staged by hand.
  const opening = app.waitForEvent('window', { predicate: window => window.url().endsWith('player.html'), timeout: 20000 })
  await page.evaluate(() => { document.querySelector<HTMLButtonElement>('#detach-stream')!.click() })
  const playerWindow = await opening.catch(() => null)
  if (!playerWindow) throw new Error('The detached player window never opened: no second window loading player.html.')
  await page.waitForFunction(() => !document.querySelector<HTMLElement>('#detached-panel')!.hidden)
  await page.evaluate(view => {
    const status = document.querySelector<HTMLElement>('#detached-panel-status')!
    status.textContent = view.detachedStatus
    status.className = 'quiet-tag playing'; status.setAttribute('style', 'color:var(--lime);border-color:var(--g47)')
  }, VIEW_TEXT)
  await playerWindow.setViewportSize({ width: 640, height: 400 })
  await playerWindow.evaluate(({ frame, view }) => {
    const one = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!
    const style = document.createElement('style')
    style.textContent = '*,*::before,*::after{transition-duration:0s!important;animation-duration:0s!important}'
    document.head.append(style)
    one('#detached-placeholder').hidden = true
    one('#detached-stage').style.background = `url(${frame}) center / cover no-repeat`
    one('#detached-channel').textContent = '# studio_nova'
    const status = one('#detached-status'); status.textContent = view.detachedStatus
    status.className = 'quiet-tag playing'; status.setAttribute('style', 'color:var(--lime);border-color:var(--g47)')
    one<HTMLButtonElement>('#detached-stop').hidden = false
    one<HTMLButtonElement>('#detached-fullscreen').disabled = false
    one<HTMLSelectElement>('#detached-quality').value = '720p60,720p,best'
  }, { frame: stream, view: VIEW_TEXT })
  await shootDetached('app-detached', playerWindow)

  // Fifth screen: exploring the channels, one page of the catalog.
  // The view switch is done the way the application does it — one section of `main` shown at
  // a time, the title bar naming it. Its own handler is not usable here: it walks the message
  // list and the player, and both have been replaced by the staged chat above.
  await page.evaluate(note => {
    for (const [selector, shown] of [['#welcome', false], ['#room-view', false], ['#settings', false], ['#discover', true]] as const) {
      document.querySelector<HTMLElement>(selector)!.hidden = !shown
    }
    document.querySelector('#app .titlebar-note')!.textContent = note
  }, VIEW_TEXT.titlebarDiscover)
  await page.waitForTimeout(400)
  await page.evaluate(({ streams, frame, view, icons }) => {
    const one = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!
    one('#discover-status').hidden = true
    one('#discover-skeleton').hidden = true
    one('#discover-summary').textContent = view.discoverSummary
    const freshness = one('#discover-freshness'); freshness.hidden = false; freshness.textContent = view.freshness

    // The same chips the view builds: `tag-filter`, the catch-all first and selected, then one
    // per category with its count. The class matters — an invented one renders as a bare button.
    const categories = one('#discover-categories'); categories.hidden = false
    const tagList = one('#discover-tag-list'); tagList.replaceChildren()
    const counts = new Map<string, number>()
    for (const stream of streams) counts.set(stream.game, (counts.get(stream.game) ?? 0) + 1)
    const all = document.createElement('button'); all.type = 'button'; all.className = 'tag-filter'
    all.textContent = view.allCategories; all.setAttribute('aria-pressed', 'true')
    tagList.append(all)
    for (const [name, count] of [...counts].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))) {
      const tag = document.createElement('button'); tag.type = 'button'; tag.className = 'tag-filter'
      tag.setAttribute('aria-pressed', 'false'); tag.append(name)
      const badge = document.createElement('b'); badge.textContent = String(count)
      tag.append(badge)
      tagList.append(tag)
    }

    const results = one('#discover-results'); results.hidden = false; results.replaceChildren()
    streams.forEach((stream, index) => {
      const article = document.createElement('article'); article.className = 'stream-card'
      const preview = document.createElement('div'); preview.className = 'stream-preview'
      // One demo frame, framed differently on each card: a tight crop at its own origin and
      // its own cast, so six previews come out of it without inventing six stream contents.
      const thumb = document.createElement('img'); thumb.className = 'stream-thumb'
      thumb.src = frame; thumb.alt = ''; thumb.width = 440; thumb.height = 248; thumb.decoding = 'async'
      const framing = [
        { scale: 1, origin: '50% 50%', hue: 0 },
        { scale: 2.4, origin: '78% 72%', hue: 52 },
        { scale: 3.1, origin: '22% 38%', hue: 128 },
        { scale: 1.9, origin: '64% 24%', hue: 196 },
        { scale: 2.8, origin: '12% 78%', hue: 268 },
        { scale: 2.2, origin: '88% 30%', hue: 310 }
      ][index % 6]!
      thumb.style.transform = `scale(${framing.scale})`
      thumb.style.transformOrigin = framing.origin
      thumb.style.filter = `hue-rotate(${framing.hue}deg) saturate(1.08)`
      preview.append(thumb)
      const badge = document.createElement('span'); badge.className = 'stream-live'; badge.innerHTML = '<i></i>'; badge.append(view.liveTag)
      const since = document.createElement('span'); since.className = 'stream-uptime'; since.innerHTML = icons.clock; since.append(` ${stream.uptime}`)
      const viewers = document.createElement('span'); viewers.className = 'stream-viewers'; viewers.innerHTML = icons.people; viewers.append(` ${stream.viewers}`)
      preview.append(since, badge, viewers)

      const body = document.createElement('div'); body.className = 'stream-card-body'
      const avatar = document.createElement('span'); avatar.className = 'stream-avatar demo-room'; avatar.setAttribute('style', stream.avatar)
      const identity = document.createElement('div'); identity.className = 'stream-identity'
      const name = document.createElement('strong'); name.textContent = stream.channel
      const title = document.createElement('p'); title.className = 'stream-title'; title.textContent = stream.title
      identity.append(name, title)
      body.append(avatar, identity)

      const meta = document.createElement('div'); meta.className = 'stream-meta'
      const game = document.createElement('button'); game.type = 'button'; game.className = 'stream-game'
      game.textContent = stream.game; game.setAttribute('aria-pressed', 'false')
      meta.append(game)
      for (const label of stream.tags.slice(0, 3)) {
        const tag = document.createElement('span'); tag.className = 'stream-tag'; tag.textContent = label
        meta.append(tag)
      }

      const join = document.createElement('button'); join.type = 'button'; join.className = 'join-stream'
      join.innerHTML = icons.chat; join.append(stream.joined ? view.joined : view.join)
      if (stream.joined) join.dataset.joined = 'true'

      article.append(preview, body, meta, join)
      results.append(article)
    })
  }, {
    frame: stream, view: { ...VIEW_TEXT, liveTag: TEXT.liveTag },
    icons: { clock: glyph('clock'), people: glyph('people'), chat: await page.evaluate(() => document.querySelector('[data-icon="chat"]')!.innerHTML) },
    streams: STREAMS.map(entry => ({ ...entry, avatar: avatarStyle(entry.avatar) }))
  })
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll<HTMLImageElement>('.stream-thumb')]
    return images.length > 0 && images.every(image => image.complete && image.naturalWidth > 0)
  }, undefined, { timeout: 20000 })
  // The grid keeps whatever scroll the view had: from the top, the categories row stays whole.
  await page.evaluate(() => { document.querySelector('#discover-content')!.scrollTop = 0 })
  await shoot('app-discover')

  // Screen: the channels the account follows. The live ones keep the grid, the others land in
  // their own list underneath — a followed channel is worth showing even when it is off air.
  await page.evaluate(({ offline, chrome, heading }) => {
    const one = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!
    one('#scope-top').setAttribute('aria-pressed', 'false')
    one('#scope-followed').setAttribute('aria-pressed', 'true')
    // The language filter only speaks of popular channels: the application dims it here.
    one('#discover-language-field').classList.add('is-muted')
    one('#discover-summary').textContent = chrome.followedSummary
    one('#discover-categories').hidden = true
    // The grid keeps the first live channels; the rest of the follow list is offline.
    const results = one('#discover-results')
    while (results.children.length > 3) results.lastElementChild!.remove()

    const section = one('#followed-offline'); section.hidden = false
    one('#followed-offline-label').textContent = heading
    const list = one('#followed-offline-list'); list.replaceChildren()
    for (const channel of offline) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'followed-card'
      const avatar = document.createElement('span'); avatar.className = 'followed-avatar demo-room'; avatar.setAttribute('style', channel.avatar)
      const name = document.createElement('span'); name.className = 'followed-name'; name.textContent = channel.channel
      button.append(avatar, name)
      list.append(button)
    }
  }, {
    chrome: TEXT,
    heading: offlineHeading(TEXT.offline.length),
    offline: TEXT.offline.map((channel, index) => ({ channel, avatar: avatarStyle((index + 4) % 12) }))
  })
  await page.evaluate(() => { document.querySelector('#discover-content')!.scrollTop = 0 })
  await shoot('app-followed')

  // Sixth screen: the settings. Nothing to stage — the panel says what it holds on its own.
  await page.evaluate(note => {
    document.querySelector<HTMLElement>('#discover')!.hidden = true
    document.querySelector<HTMLElement>('#settings')!.hidden = false
    document.querySelector('#app .titlebar-note')!.textContent = note
  }, VIEW_TEXT.titlebarSettings)
  await page.waitForTimeout(400)
  await shoot('app-settings')

} finally { await app.close() }
