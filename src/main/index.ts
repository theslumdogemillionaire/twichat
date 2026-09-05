import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, net, Notification, protocol, safeStorage, screen, session, shell, type IpcMainInvokeEvent } from 'electron'
import { join, resolve, sep, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { renameSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { TwitchIrc } from './irc'
import { TwitchEventSub } from './eventsub'
import type { RaidNotice } from './eventsub-parse'
import { DatabaseTooNew } from './database'
import { ANONYMOUS_SCOPE, PreferencesStore, scopeName } from './preferences'
import { AccountStore } from './accounts'
import { createAccountSession } from './account-session'
import { AvatarStore } from './avatars'
import { StreamResolver, withoutAds } from './streams'
import { getChannelInfo, getFollowStatus, getFollowedChannels, getHelixProfiles, getHelixStreams, getRoomProfiles, getUserCard } from './twitch-data'
import { getThirdPartyEmotes } from './third-party-emotes'
import { getTwitchEmotes } from './twitch-emotes'
import { applyUpdate, watchUpdates } from './updates'
import { bufferMode, channelName, chatReply, mediaUrl, PLAYER_WINDOW_MIN_HEIGHT, PLAYER_WINDOW_MIN_WIDTH, qualityName, WINDOW_MIN_HEIGHT, WINDOW_MIN_WIDTH } from '../shared/validation'
import type { ChatEvent, CommandKey, DetachedContext, MentionNotice, Preferences } from '../shared/types'
import { AppError, errorKey, fail, serializeError, type ErrorKey } from '../shared/errors'
import { locale as activeLocale, m, resolveLocale, setLocale } from '../shared/i18n'

const here = fileURLToPath(new URL('.', import.meta.url))
// Reachable both from the renderer and from the help menu, so the addresses live in one place.
const externalDocs = {
  'auth-docs': 'https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/#implicit-grant-flow',
}
app.setName('Twichat')
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
// Isolated data location for automated desktop checks; never touches the user's rooms.
if (process.env.TWICHAT_TEST_DATA) app.setPath('userData', process.env.TWICHAT_TEST_DATA)
const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()
app.enableSandbox()
protocol.registerSchemesAsPrivileged([
  { scheme: 'twichat', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: 'twitch-media', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
])

let window: BrowserWindow | null = null
/**
 * Video pulled out of the room. It lives in its own window, resized freely, and is the
 * only player running meanwhile: `StreamResolver` holds a single stream, so the room asks
 * for none as long as `detached` names a channel.
 */
let playerWindow: BrowserWindow | null = null
let detached: { channel: string; quality: string; play: boolean } | null = null
// The application going down closes the video window without the room hearing it: quitting is
// not the account saying it wants the video back in the dock.
let shuttingDown = false
const irc = new TwitchIrc()
const eventSub = new TwitchEventSub({ fetch: (url, init) => net.fetch(url, init) })
const resolver = new StreamResolver((url, init) => net.fetch(url, init), () => accountSession?.credentials().token ?? null)
let preferences: Preferences
let store: PreferencesStore
let accountStore: AccountStore
let avatarStore: AvatarStore
/**
 * The Twitch account: its credentials, the ways in and out, the renewal and the two lists that
 * belong to it. Built in `whenReady`, since it needs the stores — before that the application has
 * no window, no handler and no chat, so nothing here is reachable.
 */
let accountSession: ReturnType<typeof createAccountSession> | undefined
/** Answers whether a renewal was adopted — a session found intact renews nothing. */
function checkSession() { return accountSession ? accountSession.check() : Promise.resolve(false) }
/** The account's credentials for a Helix call, or the failure the renderer shows in its place. */
function accountAuth(missing: ErrorKey) {
  const { token, clientId } = accountSession?.credentials() ?? { token: null, clientId: null }
  if (!token || !clientId) fail(missing)
  return { token, clientId }
}

let initialAccountRestore: Promise<void> | undefined
/** The account whose preferences are loaded. Every write lands in this scope, never in another. */
let activeScope = ANONYMOUS_SCOPE
/** Apply the scope geometry to the window: only `createWindow` can measure it and clamp it to a display. */
let applyScopeWindow: ((preferences: Preferences) => void) | undefined
/** The native menu does not live in the DOM: it is rebuilt on every language change. */
let rebuildMenu: (() => void) | undefined

/**
 * Applies the language of a preferences set: the account's own choice, otherwise the first
 * system language we can speak. Returns true when the language changed.
 */
function applyLanguage(source: Preferences): boolean {
  // `TWICHAT_LOCALE` pins the language for the tests: their selectors no longer depend on
  // the language of the machine running them.
  const next = resolveLocale(process.env.TWICHAT_LOCALE ?? source.language, app.getPreferredSystemLanguages())
  if (next === activeLocale) return false
  setLocale(next)
  rebuildMenu?.()
  return true
}
let queuedAuthUrl: string | undefined
let pendingBrowserAuth: { verifier: string; generation: number; resolve: (login: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | undefined
const mediaRequests = new Set<AbortController>()
// A busy room must not flood the notification center: one mention per room every twenty seconds
// or so, the room counter carrying the others.
const MENTION_NOTICE_INTERVAL = 20_000
const lastMentionNotice = new Map<string, number>()
let events: ChatEvent[] = []
const flush = setInterval(() => {
  if (!events.length || !window || window.isDestroyed()) return
  window.webContents.send('chat:events', events)
  events = []
}, 80)
function queue(event: ChatEvent) {
  if (event.type === 'account' && event.login === null) {
    accountSession?.disconnected()
    eventSub.stop()
  }
  // Drop oldest chat traffic under extreme load, never control/moderation events
  // nor the system lines (subscriptions, raids, announcements): those are what matter during a flood.
  if (events.length >= 600) {
    const index = events.findIndex(item => item.type === 'message' && !item.message.system)
    if (index >= 0) events.splice(index, 1)
    else events.shift()
  }
  events.push(event)
  // ROOMSTATE lands after the JOIN: it carries the channel id EventSub expects.
  if (event.type === 'roomstate' && event.channel === preferences?.active) refreshRaidWatch()
}
irc.on('event', queue)

// EventSub listens to a single channel, the one being watched: the only one where "follow the raid"
// means anything, and one subscription instead of twenty. The raid then reaches the renderer with its system line.
function refreshRaidWatch() {
  const channel = preferences?.active ?? ''
  const broadcasterId = channel ? irc.roomStates.get(channel)?.['room-id'] ?? '' : ''
  const { token, clientId } = accountSession?.credentials() ?? { token: null, clientId: null }
  eventSub.watch(token && clientId ? { token, clientId } : null, channel, broadcasterId)
}
eventSub.on('raid', (raid: RaidNotice) => {
  // The same sentence as an incoming raid, seen from the other side: the channel, where it goes, who follows.
  irc.system(raid.from, m.chat.raidOutgoing(raid.toDisplayName, raid.viewers))
  queue({ type: 'raid', channel: raid.from, to: raid.to, toDisplayName: raid.toDisplayName, viewers: raid.viewers })
})
eventSub.on('notice', (channel: string, text: string) => irc.system(channel, text))
// A refused subscription that names the token, not the raids: renewing the session answers it.
// A session that was alive all along leaves the refusal to the subscription, which tries again —
// and says so if Twitch holds, so a 401 that is not an expiry never passes in silence.
eventSub.on('unauthorized', () => void checkSession().then(renewed => { if (!renewed) eventSub.retrySubscription() }))

function stopMedia() { resolver.stop(); for (const request of mediaRequests) request.abort(); mediaRequests.clear() }
/** The address of either application page, in development as in the shipped app. */
function pageUrl(page: 'index.html' | 'player.html') {
  const dev = process.env.ELECTRON_RENDERER_URL
  return dev ? new URL(`/${page}`, dev).href : `twichat://app/${page}`
}
/**
 * Does the call come from one of our windows, and from its page? The room keeps the whole IPC;
 * the video window only gets the channels explicitly opened to it.
 */
function trustedFrom(event: IpcMainInvokeEvent, allowPlayer: boolean) {
  const frame = event.senderFrame
  const isPlayer = !!playerWindow && !playerWindow.isDestroyed() && event.sender === playerWindow.webContents
  const source = isPlayer ? (allowPlayer ? playerWindow : null) : (window && event.sender === window.webContents ? window : null)
  if (!source || frame !== source.webContents.mainFrame) fail('originForbidden')
  const current = frame.url
  const dev = process.env.ELECTRON_RENDERER_URL
  if (!(dev ? new URL(current).origin === new URL(dev).origin : current === pageUrl(isPlayer ? 'player.html' : 'index.html'))) fail('originForbidden')
}
function trusted(event: IpcMainInvokeEvent) { trustedFrom(event, false) }
function isAppPage(url: string) {
  try {
    const dev = process.env.ELECTRON_RENDERER_URL
    return dev ? new URL(url).origin === new URL(dev).origin : url === pageUrl('index.html') || url === pageUrl('player.html')
  } catch { return false }
}
/** Our windows, and only ours: the room and the detached video share the same need for fullscreen. */
function ownContents(contents: Electron.WebContents | null) {
  return !!contents && (contents === window?.webContents || (!!playerWindow && !playerWindow.isDestroyed() && contents === playerWindow.webContents))
}
/**
 * Electron only forwards an `Error`'s message: a known error therefore goes back as an
 * envelope the preload unwraps. The key crosses the IPC, and the renderer translates it.
 */
function handle(name: string, callback: (...args: any[]) => unknown) {
  ipcMain.handle(name, async (event, ...args) => {
    trusted(event)
    try { return await callback(...args) }
    catch (error) {
      // A call Twitch answered 401 has just proved the token dead, before the appointment taken
      // on its announced expiry. The renewal starts here rather than waiting for that one.
      const key = errorKey(error)
      if (key && SESSION_EXPIRED.has(key)) void checkSession()
      return serializeError(error) ?? Promise.reject(error)
    }
  })
}
/** The channels the video window shares with the room: the stream, and its own lifecycle. */
function handleShared(name: string, callback: (...args: any[]) => unknown) {
  ipcMain.handle(name, async (event, ...args) => {
    trustedFrom(event, true)
    try { return await callback(...args) }
    catch (error) { return serializeError(error) ?? Promise.reject(error) }
  })
}
/**
 * The modifier the window hangs its shortcuts off: `⌘` on a Mac, Ctrl on Windows and Linux.
 *
 * `TWICHAT_COMMAND_KEY` pins it for the desktop check, the way `TWICHAT_LOCALE` pins the
 * language. Without it the Ctrl labels are only ever drawn on a machine no smoke here runs on.
 */
function commandKey(): CommandKey {
  const pinned = process.env.TWICHAT_COMMAND_KEY
  if (pinned === 'meta' || pinned === 'ctrl') return pinned
  return process.platform === 'darwin' ? 'meta' : 'ctrl'
}

/** The keys Helix answers a dead token with, whichever section made the call. */
const SESSION_EXPIRED = new Set<ErrorKey>(['twitchSessionExpired', 'emotesSessionExpired'])

// The avatar is cached on disk so the session chooser can show it before any Twitch call.
async function rememberAvatar(login: string, auth: { token: string; clientId: string }) {
  if (await avatarStore.fresh(login)) return
  const [profile] = await getHelixProfiles([login], auth.token, auth.clientId)
  if (profile?.avatarUrl) await avatarStore.remember(login, profile.avatarUrl)
}

/**
 * Switches everything an account owns: its rooms, its active room, its sizes, its quality,
 * its theme and its window. Nothing the previous account set survives the switch, and the
 * renderer receives the new set to bring itself up to date.
 * The rooms themselves are joined by the renderer: it is the one holding the list.
 */
async function switchScope(login: string | null) {
  const scope = scopeName(login)
  if (scope === activeScope) return
  // The outgoing scope's last write must land before another one is loaded.
  await store.settled()
  activeScope = scope
  store.rememberScope(scope)
  preferences = await store.load(scope)
  applyLanguage(preferences)
  nativeTheme.themeSource = preferences.theme
  applyScopeWindow?.(preferences)
  window?.webContents.send('app:preferences', { scope, preferences, locale: activeLocale })
  refreshRaidWatch()
}

function focusWindow() {
  if (!window || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.show(); window.focus()
}
async function completeBrowserAuthentication(rawUrl: string) {
  let url: URL
  try { url = new URL(rawUrl) } catch { return }
  if (url.protocol !== 'twichat:' || url.hostname !== 'auth') return
  const session = accountSession
  if (!session) { queuedAuthUrl = rawUrl; return }
  focusWindow()
  const pending = pendingBrowserAuth
  const ticket = url.searchParams.get('ticket') ?? ''
  if (!pending || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) return
  pendingBrowserAuth = undefined
  clearTimeout(pending.timer)
  try { pending.resolve(await session.claim(ticket, pending.verifier, pending.generation)) }
  catch (error) { pending.reject(error instanceof Error ? error : new AppError('authFailed')) }
}
function browserLogin(mode: 'open' | 'copy' = 'open') {
  const session = accountSession
  if (!session) fail('authFailed')
  if (pendingBrowserAuth) {
    clearTimeout(pendingBrowserAuth.timer)
    pendingBrowserAuth.reject(new AppError('authReplaced'))
  }
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const generation = session.nextGeneration()
  const destination = new URL('/auth/start', session.authServer())
  destination.searchParams.set('challenge', challenge)
  // The pages opened in the browser — down to the landing one — speak the application's language.
  destination.searchParams.set('lang', activeLocale)
  const promise = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pendingBrowserAuth?.verifier !== verifier) return
      pendingBrowserAuth = undefined
      reject(new AppError('authExpired'))
    }, 10 * 60_000)
    pendingBrowserAuth = { verifier, generation, resolve, reject, timer }
  })
  if (mode === 'copy') clipboard.writeText(destination.href)
  else {
    void shell.openExternal(destination.href).catch(error => {
      const pending = pendingBrowserAuth
      if (!pending || pending.verifier !== verifier) return
      pendingBrowserAuth = undefined; clearTimeout(pending.timer); pending.reject(error)
    })
  }
  return promise
}

app.on('open-url', (event, url) => { event.preventDefault(); void completeBrowserAuthentication(url) })
app.on('second-instance', (_event, argv) => {
  focusWindow()
  const url = argv.find(argument => argument.startsWith('twichat://auth'))
  if (url) void completeBrowserAuthentication(url)
})

/**
 * The application cannot start: its settings file will not open.
 *
 * Until this existed, the rejection went nowhere — the promise below had no terminal handler, so a
 * damaged file left a dock icon and no window, with nothing said. What is offered depends on the
 * failure. A file a newer version wrote is not damaged, and setting it aside would throw away
 * settings the other version still reads, so that one is only explained. Anything else is offered
 * the repair, and the repair renames: the file is never deleted, because a file that would not
 * open here may still open somewhere else.
 */
function cannotOpenData(path: string, error: unknown): never {
  const tooNew = error instanceof DatabaseTooNew
  // The account's own language is inside the file that will not open: the system's is what is left.
  setLocale(resolveLocale(process.env.TWICHAT_LOCALE ?? '', app.getPreferredSystemLanguages()))
  console.error('Twichat could not open its data:', error instanceof Error ? error.message : 'unknown error')
  const choice = dialog.showMessageBoxSync({
    type: 'error',
    title: m.database.title,
    message: m.database.title,
    detail: `${tooNew ? m.database.tooNew : m.database.unreadable}\n\n${m.database.location(path)}`,
    buttons: tooNew ? [m.database.quit] : [m.database.setAside, m.database.quit],
    defaultId: 0,
    cancelId: tooNew ? 0 : 1
  })
  if (!tooNew && choice === 0) {
    const kept = `${path}.broken-${new Date().toISOString().replace(/[:.]/g, '-')}`
    try {
      renameSync(path, kept)
      // WAL and its index belong to the file that was moved: left behind they would be replayed
      // into the new one, which is the damage this was meant to avoid.
      for (const suffix of ['-wal', '-shm']) { try { renameSync(`${path}${suffix}`, `${kept}${suffix}`) } catch { /* Absent unless the last session ended mid-write. */ } }
      dialog.showMessageBoxSync({ type: 'info', title: m.database.title, message: m.database.keptAt(kept), buttons: [m.database.quit] })
      app.relaunch()
    } catch (failure) {
      console.error('Twichat could not set the damaged file aside:', failure instanceof Error ? failure.message : 'unknown error')
      dialog.showMessageBoxSync({ type: 'error', title: m.database.title, message: m.database.setAsideFailed, buttons: [m.database.quit] })
    }
  }
  app.exit(1)
  throw error
}

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return
  const databasePath = join(app.getPath('userData'), 'twichat.db')
  try { store = new PreferencesStore(databasePath) }
  catch (error) { cannotOpenData(databasePath, error) }
  accountStore = new AccountStore(
    join(app.getPath('userData'), 'accounts.json'),
    async token => {
      if (!await safeStorage.isAsyncEncryptionAvailable()) fail('secureStorageUnavailable')
      return (await safeStorage.encryptStringAsync(token)).toString('base64')
    },
    async encrypted => {
      if (!await safeStorage.isAsyncEncryptionAvailable()) fail('secureStorageUnavailable')
      return (await safeStorage.decryptStringAsync(Buffer.from(encrypted, 'base64'))).result
    }
  )
  avatarStore = new AvatarStore(join(app.getPath('userData'), 'avatars.json'), url => net.fetch(url, { signal: AbortSignal.timeout(10000) }))
  const account = createAccountSession({
    accounts: accountStore,
    chat: {
      login: () => irc.login,
      connect: account => irc.connect(account),
      renewToken: token => irc.renewToken(token),
      logout: reconnectAnonymously => irc.logout(reconnectAnonymously)
    },
    fetch: (url, init) => net.fetch(url, init),
    switchScope,
    refreshRaidWatch,
    announce: outcome => irc.system(preferences.active, outcome === 'renewed' ? m.chat.sessionRenewed : m.chat.sessionExpired),
    rememberAvatar,
    forgetAvatar: login => avatarStore.forget(login),
    forgetPreferences: login => store.forget(scopeName(login)),
    streams: (token, clientId, language) => getHelixStreams(token, clientId, language),
    followed: (userId, auth) => getFollowedChannels(userId, auth)
  })
  accountSession = account
  // The previous version knew nothing of accounts: its file is taken over by the account that
  // wrote it — the auto-login one, otherwise the last used — rather than lost.
  const legacyOwner = await accountStore.preferred() ?? (await accountStore.list())[0] ?? ANONYMOUS_SCOPE
  await store.importLegacyFile(join(app.getPath('userData'), 'preferences.json'), legacyOwner)
  // Before any account is chosen, the application takes back the last session's scope: the
  // session gate opens with the theme and the size we left.
  activeScope = store.lastScope() ?? ANONYMOUS_SCOPE
  preferences = await store.load(activeScope)
  // The language is set before the first paint: menu, notifications and renderer agree.
  setLocale(resolveLocale(process.env.TWICHAT_LOCALE ?? preferences.language, app.getPreferredSystemLanguages()))
  // Also sets `prefers-color-scheme` in the renderer: the window opens on the right theme already.
  nativeTheme.themeSource = preferences.theme
  const root = resolve(here, '../renderer')
  if (process.platform === 'darwin') app.dock?.setIcon(join(root, 'twichat-logo.png'))
  if (process.defaultApp && process.argv[1]) app.setAsDefaultProtocolClient('twichat', process.execPath, [resolve(process.argv[1])])
  else app.setAsDefaultProtocolClient('twichat')
  protocol.handle('twichat', async request => {
    const url = new URL(request.url)
    const path = resolve(root, `.${decodeURIComponent(url.pathname)}`)
    if (url.hostname !== 'app' || !path.startsWith(root + sep)) return new Response(null, { status: 403 })
    try {
      const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }
      return new Response(await readFile(path), { headers: { 'Content-Type': types[extname(path)] ?? 'application/octet-stream' } })
    } catch { return new Response(null, { status: 404 }) }
  })
  protocol.handle('twitch-media', async request => {
    let controller: AbortController | undefined
    try {
      const url = mediaUrl(request.url.replace(/^twitch-media:/, 'https:'))
      if (!['GET', 'HEAD'].includes(request.method) || mediaRequests.size >= 12) return new Response(null, { status: 429 })
      controller = new AbortController()
      mediaRequests.add(controller)
      const signal = AbortSignal.any([controller.signal, request.signal, AbortSignal.timeout(20000)])
      const headers = new Headers()
      const range = request.headers.get('Range')
      if (range && /^bytes=\d+-\d*$/.test(range)) headers.set('Range', range)
      let current = url
      let upstream: Response | undefined
      for (let redirects = 0; redirects <= 5; redirects++) {
        upstream = await net.fetch(current.href, { method: request.method, headers, signal, redirect: 'manual' })
        if (![301, 302, 303, 307, 308].includes(upstream.status)) break
        const location = upstream.headers.get('Location')
        if (!location || redirects === 5) fail('mediaRedirectInvalid')
        current = mediaUrl(new URL(location, current).href)
      }
      if (!upstream) fail('mediaResponseMissing')
      const outgoing = new Headers(upstream.headers)
      outgoing.set('Access-Control-Allow-Origin', '*')
      outgoing.set('Cache-Control', 'no-store')
      const isManifest = url.pathname.endsWith('.m3u8') || /mpegurl/i.test(upstream.headers.get('Content-Type') ?? '')
      if (isManifest) {
        const declared = Number(upstream.headers.get('Content-Length') ?? 0)
        if (declared > 2 * 1024 * 1024) { mediaRequests.delete(controller); return new Response(null, { status: 413 }) }
        const text = await upstream.text()
        mediaRequests.delete(controller)
        if (text.length > 2 * 1024 * 1024) return new Response(null, { status: 413 })
        // Twitch stitches its advertising into the stream's own variant: this is the one place
        // the playlist is ours to read, and so the only place it can come back out.
        const rewritten = withoutAds(text).replace(/https:\/\/([a-z0-9.-]+\.(?:ttvnw\.net|twitchcdn\.net))/gi, 'twitch-media://$1')
        outgoing.set('Content-Type', 'application/vnd.apple.mpegurl')
        outgoing.delete('Content-Length')
        return new Response(rewritten, { status: upstream.status, headers: outgoing })
      }
      // Stream segments directly via the protocol, not serialised copies over IPC.
      const reader = upstream.body?.getReader()
      const active = controller
      const body = reader ? new ReadableStream({
        async pull(destination) {
          try {
            const result = await reader.read()
            if (result.done) { mediaRequests.delete(active); destination.close() }
            else destination.enqueue(result.value)
          } catch (error) { mediaRequests.delete(active); destination.error(error) }
        },
        cancel() { active.abort(); mediaRequests.delete(active); return reader.cancel() }
      }) : null
      if (!body) mediaRequests.delete(active)
      return new Response(body, { status: upstream.status, headers: outgoing })
    } catch (error) {
      if (controller) mediaRequests.delete(controller)
      if (!(error instanceof Error && error.name === 'AbortError')) console.error('Twitch media request failed:', error instanceof Error ? error.message : 'unknown error')
      return new Response('Stream unavailable', { status: 502 })
    }
  })
  // Fullscreen is the only browser permission the local renderer needs.
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(permission === 'fullscreen' && ownContents(contents) && isAppPage(details.requestingUrl))
  })
  session.defaultSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    return permission === 'fullscreen' && ownContents(contents) && details.isMainFrame && isAppPage(details.requestingUrl ?? requestingOrigin)
  })

  handle('app:init', async () => {
    initialAccountRestore ??= account.restore()
    await initialAccountRestore
    return { preferences, scope: activeScope, locale: activeLocale, commandKey: commandKey(), insetWindowControls: process.platform === 'darwin', status: irc.status, account: irc.login, savedAccounts: await accountStore.list(), savedAvatars: await avatarStore.all(), roomStates: Object.fromEntries(irc.roomStates), userBadges: Object.fromEntries(irc.userBadges) }
  })
  handle('account:avatars', () => avatarStore.all())
  handle('chat:join', (channel: string) => irc.join(channel))
  handle('chat:part', (channel: string) => irc.part(channel))
  handle('chat:send', (channel: string, text: string, reply: unknown) => irc.send(channel, text, chatReply(reply)))
  handle('chat:reconnect', () => irc.connect())
  handle('session:anonymous', async () => { await accountStore.pauseAutoLogin(); account.logout(); return undefined })
  // Window geometry does not belong to the renderer: it is taken from the store, never from the payload.
  handle('preferences:save', async (input: Preferences, scope: unknown) => {
    // A save sent before a switch carries the previous account's rooms: it is dropped rather
    // than written into the next account's row.
    if (typeof scope !== 'string' || scope !== activeScope) return
    preferences = await store.patch(activeScope, current => ({ ...input, window: current.window, playerWindow: current.playerWindow }))
    applyLanguage(preferences)
    nativeTheme.themeSource = preferences.theme
    // Changing room moves the raid watch: the new channel is the one being watched.
    refreshRaidWatch()
  })
  handle('rooms:activity', () => store.channelActivity(activeScope))
  // The renderer holds the room list and sees the messages: it says what stirred, the store dates it.
  handle('rooms:mark-activity', (channels: string[]) => { store.markChannelActivity(activeScope, channels) })
  handle('rooms:profiles', (channels: string[]) => {
    const { token, clientId } = account.credentials()
    return getRoomProfiles(channels, token && clientId ? { token, clientId } : null)
  })
  handle('chatters:profiles', (logins: string[]) => {
    const { token, clientId } = accountAuth('needAccountForAvatars')
    return getHelixProfiles(logins, token, clientId)
  })
  handle('user:card', (login: unknown) => getUserCard(login, accountAuth('needAccountForProfile')))
  handle('channel:info', (channel: unknown, roomId: unknown) => getChannelInfo(channel, roomId, accountAuth('needAccountForChannelInfo')))
  handle('emotes:third-party', (channel: unknown, roomId: unknown) => {
    const name = channelName(channel)
    if (typeof roomId !== 'string' || !/^\d{1,30}$/.test(roomId)) fail('roomIdInvalid')
    return getThirdPartyEmotes(name, roomId)
  })
  handle('emotes:twitch', (roomId: unknown) => {
    if (typeof roomId !== 'string' || !/^\d{1,30}$/.test(roomId)) fail('roomIdInvalid')
    return getTwitchEmotes(roomId, accountAuth('needAccountForEmotes'))
  })
  handle('discover:streams', async (language: unknown = '', refresh = false) => {
    if (typeof language !== 'string' || (language && !/^[a-z]{2}$/.test(language))) fail('languageInvalid')
    if (typeof refresh !== 'boolean') fail('refreshRequestInvalid')
    return account.data.streams(language, refresh)
  })
  handle('discover:followed', async (refresh = false) => {
    if (typeof refresh !== 'boolean') fail('refreshRequestInvalid')
    return account.data.followed(refresh)
  })
  // Twichat reads the follow, it never sets it: Twitch closed its "follow" endpoints on 27 July 2021.
  // What this answer allows is to say why a room refuses a message, and when it will accept one.
  handle('follow:status', (channel: unknown, roomId: unknown) => {
    const auth = accountAuth('needAccountForFollow')
    return getFollowStatus(channel, roomId, account.credentials().userId ?? '', auth)
  })
  handle('account:authenticate', async (input: unknown) => {
    if (typeof input !== 'string') fail('tokenInvalid')
    const token = input.trim().replace(/^oauth:/, '')
    if (!/^[a-zA-Z0-9]{20,200}$/.test(token)) fail('tokenFormat')
    return account.authenticate(token)
  })
  handle('account:browser-login', (mode: unknown = 'open') => {
    if (mode !== 'open' && mode !== 'copy') fail('authModeInvalid')
    return browserLogin(mode)
  })
  handle('account:use-saved', (input: unknown) => account.useSaved(input))
  handle('account:logout', async () => {
    await accountStore.pauseAutoLogin()
    account.logout(false)
  })
  // The other half of signing out: nothing of this account stays on the machine. Signing it out
  // first, when it is the one connected, so the chat and the scope do not keep working under a
  // login that no longer exists anywhere.
  handle('account:forget', async (input: unknown) => {
    const login = channelName(input)
    if (irc.login === login) account.logout(false)
    await account.forget(login)
    return accountStore.list()
  })
  handleShared('stream:resolve', (channel: string, quality: string) => { stopMedia(); return resolver.resolve(channel, quality) })
  handleShared('stream:stop', stopMedia)
  handle('player:detach', (channel: string, quality: string, play: unknown) => { openPlayerWindow(channelName(channel), qualityName(quality), play === true) })
  handleShared('player:attach', () => { closePlayerWindow() })
  /**
   * The room drives its player wherever the picture is. Nothing here decides anything: the
   * dock's own rules — autoplay on entering, stop on leaving, on the settings, on chat only —
   * arrive already resolved, and the window applies them as the dock would have.
   */
  handle('player:command', (action: unknown, channel: unknown, quality: unknown, buffer: unknown) => {
    if (!playerWindow || playerWindow.isDestroyed() || !detached) return
    if (action !== 'play' && action !== 'stop') return
    // A stop without a channel leaves the room where it was: only a move renames the window.
    const room = action === 'play' || channel ? channelName(channel) : detached.channel
    detached = { channel: room, quality: action === 'play' ? qualityName(quality) : detached.quality, play: action === 'play' }
    playerWindow.setTitle(`#${room} · Twichat`)
    playerWindow.webContents.send('app:player-command', action, room, detached.quality, bufferMode(buffer))
    // The room's anchor names what plays on the side, so it follows the channel too.
    toRoom('app:player-detached', room)
  })
  handleShared('player:context', (): DetachedContext => ({
    channel: detached?.channel ?? '', quality: detached?.quality ?? preferences.quality,
    pinned: preferences.playerWindow?.pinned === true, play: detached?.play !== false,
    playback: preferences.playback, theme: preferences.theme, locale: activeLocale
  }))
  // The video window never writes preferences: it reports what it does, the room stays the only author.
  handleShared('player:state', (state: unknown, message: unknown) => {
    toRoom('app:player-state', text(state, 40), text(message, 300))
  })
  handleShared('player:quality', (quality: string) => { toRoom('app:player-quality', qualityName(quality)) })
  /**
   * The window takes the shape of its picture. Locking the ratio is what removes the black
   * margins: the user drags a corner and the video keeps filling the frame, the control bar
   * excluded from the calculation. A ratio of 0 — audio only — gives the freedom back.
   */
  handleShared('player:frame', (ratio: unknown, chrome: unknown) => {
    const target = playerWindow
    if (!target || target.isDestroyed()) return
    const shape = typeof ratio === 'number' && Number.isFinite(ratio) && ratio >= .2 && ratio <= 5 ? ratio : 0
    const extra = typeof chrome === 'number' && Number.isFinite(chrome) ? Math.min(400, Math.max(0, Math.round(chrome))) : 0
    target.setAspectRatio(shape, shape ? { width: 0, height: extra } : { width: 0, height: 0 })
    // The floor follows the shape too: a minimum height fixed once would fight the ratio and
    // leave back the margin it is meant to remove.
    const frame = target.getBounds().height - target.getContentBounds().height
    target.setMinimumSize(PLAYER_WINDOW_MIN_WIDTH, shape
      ? Math.round(PLAYER_WINDOW_MIN_WIDTH / shape) + extra + frame
      : PLAYER_WINDOW_MIN_HEIGHT)
    if (!shape || target.isFullScreen() || target.isMaximized()) return
    // Locking the ratio only governs the next resize: the window still has to be put right once.
    const content = target.getContentBounds()
    const height = Math.round(content.width / shape) + extra
    if (Math.abs(height - content.height) > 2) target.setContentBounds({ ...content, height })
  })
  handleShared('player:pin', (pinned: unknown) => {
    const target = playerWindow
    if (!target || target.isDestroyed()) return
    const above = pinned === true
    target.setAlwaysOnTop(above)
    const scope = activeScope
    void store.patch(scope, current => ({ ...current, playerWindow: current.playerWindow ? { ...current.playerWindow, pinned: above } : current.playerWindow }))
      .then(saved => { if (scope === activeScope) preferences = saved }, () => {})
  })
  handleShared('player:volume', (volume: unknown, muted: unknown) => {
    toRoom('app:player-volume', typeof volume === 'number' && Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 1, muted === true)
  })
  // The renderer has no clipboard permission by design; copying stays an explicit, bounded request.
  handle('app:apply-update', () => applyUpdate())
  handle('app:copy', (text: unknown) => {
    if (typeof text !== 'string' || !text || text.length > 4096) fail('copyTextInvalid')
    clipboard.writeText(text)
  })
  // A mention only becomes a system notification while the window is in the background: in front,
  // the room counter is enough. The main process alone decides; the renderer merely reports.
  handle('app:notify-mention', (input: unknown) => {
    const notice = (input ?? {}) as Partial<MentionNotice>
    // Validation comes first: a malformed payload is an error, focused window or not.
    const channel = channelName(notice.channel)
    const author = typeof notice.user === 'string' && notice.user.trim() ? notice.user.trim().slice(0, 40) : channel
    const body = typeof notice.text === 'string' ? notice.text.replace(/\s+/g, ' ').trim().slice(0, 200) : ''
    if (!window || window.isDestroyed() || window.isFocused() || !Notification.isSupported()) return
    const now = Date.now()
    if (now - (lastMentionNotice.get(channel) ?? 0) < MENTION_NOTICE_INTERVAL) return
    for (const [room, at] of lastMentionNotice) if (now - at > MENTION_NOTICE_INTERVAL) lastMentionNotice.delete(room)
    lastMentionNotice.set(channel, now)
    const notification = new Notification({ title: m.notifications.mention(author, channel), body })
    // The click brings the room back: the window comes forward, the renderer moves to it.
    notification.on('click', () => {
      focusWindow()
      if (window && !window.isDestroyed()) window.webContents.send('app:mention-open', channel)
    })
    notification.show()
  })
  handle('app:external', (target: string, channel?: string) => {
    const urls: Record<string, string> = { twitch: `https://www.twitch.tv/${channel ? channelName(channel) : ''}`, ...externalDocs }
    if (!Object.hasOwn(urls, target)) fail('linkForbidden')
    return shell.openExternal(urls[target])
  })
  /**
   * A link read in a message. Unlike the list above, the address is written by a stranger, so it
   * is checked here as well as in the window: only HTTP and HTTPS reach the browser, and never
   * a `javascript:`, a `file:` or an application scheme that would run something on the machine.
   */
  handle('app:open-link', (input: unknown) => {
    if (typeof input !== 'string' || input.length > 2048) fail('linkForbidden')
    let url: URL
    try { url = new URL(input) } catch { return fail('linkForbidden') }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') fail('linkForbidden')
    // A login written into the address is the oldest way of passing one host off as another.
    if (url.username || url.password) fail('linkForbidden')
    return shell.openExternal(url.href)
  })

  // A desktop app offers a context menu only where something can be edited or copied; inert chrome keeps its own menus.
  function popupContextMenu(target: BrowserWindow, params: Electron.ContextMenuParams) {
    const flags = params.editFlags
    if (!params.isEditable && !params.selectionText.trim()) return
    const template: Electron.MenuItemConstructorOptions[] = params.isEditable
      ? [
          { label: m.menu.undo, role: 'undo', enabled: flags.canUndo },
          { label: m.menu.redo, role: 'redo', enabled: flags.canRedo },
          { type: 'separator' },
          { label: m.menu.cut, role: 'cut', enabled: flags.canCut },
          { label: m.menu.copy, role: 'copy', enabled: flags.canCopy },
          { label: m.menu.paste, role: 'paste', enabled: flags.canPaste },
          { type: 'separator' },
          { label: m.menu.selectAll, role: 'selectAll', enabled: flags.canSelectAll }
        ]
      : [{ label: m.menu.copy, role: 'copy', enabled: flags.canCopy }]
    Menu.buildFromTemplate(template).popup({ window: target })
  }

  // The default Electron menu exposes reload and devtools; a shipped app keeps only what a user acts on.
  function applicationMenu() {
    const editing: Electron.MenuItemConstructorOptions[] = [
      { label: m.menu.undo, role: 'undo' },
      { label: m.menu.redo, role: 'redo' },
      { type: 'separator' },
      { label: m.menu.cut, role: 'cut' },
      { label: m.menu.copy, role: 'copy' },
      { label: m.menu.paste, role: 'paste' },
      { label: m.menu.selectAll, role: 'selectAll' }
    ]
    const template: Electron.MenuItemConstructorOptions[] = [
      {
        label: 'Twichat',
        submenu: [
          { label: m.menu.about, role: 'about' },
          { type: 'separator' },
          { label: m.menu.settings, accelerator: 'CmdOrCtrl+,', click: () => window?.webContents.send('app:settings') },
          { type: 'separator' },
          { label: m.menu.services, role: 'services' },
          { type: 'separator' },
          { label: m.menu.hide, role: 'hide' },
          { label: m.menu.hideOthers, role: 'hideOthers' },
          { label: m.menu.unhide, role: 'unhide' },
          { type: 'separator' },
          { label: m.menu.quit, role: 'quit' }
        ]
      },
      { label: m.menu.edit, submenu: editing },
      {
        label: m.menu.window,
        submenu: [
          { label: m.menu.minimize, role: 'minimize' },
          { label: m.menu.zoom, role: 'zoom' },
          { type: 'separator' },
          { label: m.menu.close, role: 'close' }
        ]
      },
      {
        label: m.menu.help,
        submenu: [
          { label: m.menu.getToken, click: () => void shell.openExternal(externalDocs['auth-docs']) }
        ]
      }
    ]
    // Reloading and inspecting stay reachable while developing against the Vite server.
    if (process.env.ELECTRON_RENDERER_URL) template.push({ label: m.menu.development, submenu: [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }] })
    return Menu.buildFromTemplate(template)
  }
  rebuildMenu = () => Menu.setApplicationMenu(applicationMenu())
  rebuildMenu()

  /**
   * Takes back the stored size, and the position only if it still touches a desktop: a display
   * unplugged between two launches would otherwise leave the window off screen.
   */
  function savedWindowBounds(source: Preferences): { width?: number; height?: number; x?: number; y?: number } {
    const saved = source.window
    if (!saved) return {}
    const size = { width: Math.max(saved.width, WINDOW_MIN_WIDTH), height: Math.max(saved.height, WINDOW_MIN_HEIGHT) }
    const { x, y } = saved
    if (x === undefined || y === undefined) return size
    const onScreen = screen.getAllDisplays().some(({ workArea }) =>
      x + size.width > workArea.x && x < workArea.x + workArea.width && y + size.height > workArea.y && y < workArea.y + workArea.height)
    return onScreen ? { ...size, x, y } : size
  }
  /**
   * The window of the account just opened. Fullscreen is not a size: it is left alone, and the
   * scope geometry takes over again on the way out.
   */
  applyScopeWindow = scoped => {
    if (!window || window.isDestroyed() || window.isFullScreen()) return
    if (scoped.window?.maximized) { window.maximize(); return }
    if (window.isMaximized()) window.unmaximize()
    const bounds = savedWindowBounds(scoped)
    if (bounds.width !== undefined) window.setBounds(bounds)
  }
  let boundsTimer: ReturnType<typeof setTimeout> | undefined
  function rememberWindowBounds() {
    // Fullscreen is a passing state, not a size: the restored window geometry is what we keep.
    if (!window || window.isDestroyed() || window.isFullScreen()) return
    const { width, height, x, y } = window.getNormalBounds()
    const bounds = { width, height, x, y, maximized: window.isMaximized() }
    // The scope is captured now: an account switch must not write this geometry into the next one.
    const scope = activeScope
    void store.patch(scope, current => ({ ...current, window: bounds })).then(saved => { if (scope === activeScope) preferences = saved }, () => {})
  }
  function scheduleWindowBounds() {
    clearTimeout(boundsTimer)
    boundsTimer = setTimeout(rememberWindowBounds, 250)
  }

  const text = (value: unknown, limit: number) => typeof value === 'string' ? value.slice(0, limit) : ''
  function toRoom(channel: string, ...args: unknown[]) {
    if (window && !window.isDestroyed()) window.webContents.send(channel, ...args)
  }

  /** The size left to the video window, dropped if it now falls outside the displays plugged in today. */
  function savedPlayerBounds(): { width?: number; height?: number; x?: number; y?: number } {
    const saved = preferences.playerWindow
    if (!saved) return {}
    const size = { width: Math.max(saved.width, PLAYER_WINDOW_MIN_WIDTH), height: Math.max(saved.height, PLAYER_WINDOW_MIN_HEIGHT) }
    const { x, y } = saved
    if (x === undefined || y === undefined) return size
    const onScreen = screen.getAllDisplays().some(({ workArea }) =>
      x + size.width > workArea.x && x < workArea.x + workArea.width && y + size.height > workArea.y && y < workArea.y + workArea.height)
    return onScreen ? { ...size, x, y } : size
  }
  let playerBoundsTimer: ReturnType<typeof setTimeout> | undefined
  function rememberPlayerBounds() {
    if (!playerWindow || playerWindow.isDestroyed() || playerWindow.isFullScreen()) return
    const { width, height, x, y } = playerWindow.getNormalBounds()
    const above = playerWindow.isAlwaysOnTop()
    const scope = activeScope
    void store.patch(scope, current => ({ ...current, playerWindow: { width, height, x, y, maximized: false, pinned: above } }))
      .then(saved => { if (scope === activeScope) preferences = saved }, () => {})
  }
  function schedulePlayerBounds() {
    clearTimeout(playerBoundsTimer)
    playerBoundsTimer = setTimeout(rememberPlayerBounds, 250)
  }

  /**
   * Pulls the video out of the room. The window takes back last time's size: "on the side" is a
   * setting nobody wants to redo on every opening.
   */
  function openPlayerWindow(channel: string, quality: string, play: boolean) {
    detached = { channel, quality, play }
    if (playerWindow && !playerWindow.isDestroyed()) {
      playerWindow.setTitle(`#${channel} · Twichat`)
      playerWindow.webContents.reload()
      playerWindow.focus()
      toRoom('app:player-detached', channel)
      return
    }
    const target = playerWindow = new BrowserWindow({
      width: 720, height: 440, ...savedPlayerBounds(),
      minWidth: PLAYER_WINDOW_MIN_WIDTH, minHeight: PLAYER_WINDOW_MIN_HEIGHT,
      title: `#${channel} · Twichat`, backgroundColor: '#050606', show: false,
      alwaysOnTop: preferences.playerWindow?.pinned === true,
      webPreferences: { preload: join(here, '../preload/index.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false }
    })
    target.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    target.webContents.on('will-navigate', event => event.preventDefault())
    void target.webContents.setVisualZoomLevelLimits(1, 1)
    target.webContents.on('zoom-changed', () => target.webContents.setZoomFactor(1))
    target.webContents.on('context-menu', (_event, params) => { if (!target.isDestroyed()) popupContextMenu(target, params) })
    target.once('ready-to-show', () => target.show())
    target.on('resize', schedulePlayerBounds); target.on('move', schedulePlayerBounds)
    target.on('close', () => { clearTimeout(playerBoundsTimer); rememberPlayerBounds() })
    // Closing the window by hand means "reattach": the room takes its video back.
    target.on('closed', () => {
      if (playerWindow !== target) return
      playerWindow = null
      detached = null
      stopMedia()
      if (!shuttingDown) toRoom('app:player-detached', null)
    })
    void target.loadURL(pageUrl('player.html'))
    toRoom('app:player-detached', channel)
  }
  function closePlayerWindow() {
    const target = playerWindow
    if (target && !target.isDestroyed()) target.close()
    else if (detached) { detached = null; toRoom('app:player-detached', null) }
  }

  function createWindow() {
    window = new BrowserWindow({
      width: 1320, height: 880, ...savedWindowBounds(preferences), minWidth: WINDOW_MIN_WIDTH, minHeight: WINDOW_MIN_HEIGHT,
      title: 'Twichat', backgroundColor: nativeTheme.shouldUseDarkColors ? '#151718' : '#f3f5f2', titleBarStyle: 'hiddenInset', icon: join(root, 'twichat-logo.png'),
      webPreferences: { preload: join(here, '../preload/index.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false }
    })
    // The window background is also the backdrop while resizing: it follows the theme.
    const paintWindow = () => window?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#151718' : '#f3f5f2')
    nativeTheme.on('updated', paintWindow)
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    // The mouse's side buttons and a keyboard's browser keys, where the system reports them as a
    // command rather than as a key press — Windows and Linux. macOS has no `app-command`: there
    // they arrive in the window as ordinary mouse events, and the renderer reads them itself.
    window.on('app-command', (event, command) => {
      if (command !== 'browser-backward' && command !== 'browser-forward') return
      event.preventDefault()
      toRoom('app:navigate', command === 'browser-backward' ? 'back' : 'forward')
    })
    // Pinch and Ctrl+wheel zoom belong to a document, not to an application window.
    void window.webContents.setVisualZoomLevelLimits(1, 1)
    window.webContents.on('zoom-changed', () => window?.webContents.setZoomFactor(1))
    window.webContents.on('context-menu', (_event, params) => { if (window && !window.isDestroyed()) popupContextMenu(window, params) })
    if (preferences.window?.maximized) window.maximize()
    window.on('resize', scheduleWindowBounds); window.on('move', scheduleWindowBounds)
    window.on('maximize', scheduleWindowBounds); window.on('unmaximize', scheduleWindowBounds)
    // The last gesture counts as much as the others: closing does not wait for the debounce.
    window.on('close', () => { clearTimeout(boundsTimer); rememberWindowBounds(); shuttingDown = true; closePlayerWindow() })
    window.on('closed', () => { nativeTheme.off('updated', paintWindow); window = null; stopMedia(); irc.disconnect(); eventSub.stop(); accountSession?.release() })
    window.webContents.on('did-finish-load', () => {
      for (const channel of preferences.channels) irc.join(channel)
      // Reloading the renderer does not close the video window: the room learns again that it is there.
      if (detached) toRoom('app:player-detached', detached.channel)
    })
    const dev = process.env.ELECTRON_RENDERER_URL
    if (dev) void window.loadURL(dev)
    else void window.loadURL('twichat://app/index.html')
  }
  createWindow()
  watchUpdates(notice => toRoom('app:update', notice))
  const initialUrl = queuedAuthUrl ?? process.argv.find(argument => argument.startsWith('twichat://auth'))
  queuedAuthUrl = undefined
  if (initialUrl) void completeBrowserAuthentication(initialUrl)
  app.on('activate', () => { if (!window) createWindow() })
}).catch(error => {
  // Anything else that goes wrong before the first window exists. Without this the rejection
  // goes nowhere: the process stays up holding a dock icon, and nothing ever says why.
  console.error('Twichat failed to start:', error instanceof Error ? error.stack ?? error.message : 'unknown error')
  dialog.showErrorBox(m.database.title, error instanceof Error ? error.message : 'unknown error')
  app.exit(1)
})
// The last preferences write must land before the process goes away.
app.on('window-all-closed', () => { void (store ? store.settled() : Promise.resolve()).then(() => app.quit()) })
app.on('before-quit', () => { clearInterval(flush); accountSession?.stop(); stopMedia(); irc.disconnect(); eventSub.stop() })
