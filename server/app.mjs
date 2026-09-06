import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, readFile, stat } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { buildNotFound, buildPages, sitemap } from './site-pages.mjs'
import { AUTH, DEFAULT_LOCALE, LOCALES, pickLocale } from './site-messages.mjs'

const directory = fileURLToPath(new URL('.', import.meta.url))
const defaultPublicDirectory = join(directory, 'public')
const requiredScopes = ['chat:read', 'chat:edit']
// Requested at sign-in for the list of followed channels, but never required at validation:
// a session opened before that view existed must keep renewing itself, without that scope.
const loginScopes = [...requiredScopes, 'user:read:follows']
const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'], ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'], ['.webp', 'image/webp'], ['.woff2', 'font/woff2'], ['.txt', 'text/plain; charset=utf-8'],
  ['.xml', 'application/xml; charset=utf-8']
])
// The keys are what `?platform=` accepts and what names the override variable, so they stay
// shaped like an environment variable: `deb_arm64` reads `TWICHAT_DOWNLOAD_DEB_ARM64_URL`.
const downloadFiles = {
  mac: { name: 'Twichat-mac.dmg', type: 'application/x-apple-diskimage' },
  windows: { name: 'Twichat-windows.exe', type: 'application/vnd.microsoft.portable-executable' },
  deb: { name: 'Twichat-linux-x64.deb', type: 'application/vnd.debian.binary-package' },
  rpm: { name: 'Twichat-linux-x64.rpm', type: 'application/x-rpm' },
  deb_arm64: { name: 'Twichat-linux-arm64.deb', type: 'application/vnd.debian.binary-package' },
  rpm_arm64: { name: 'Twichat-linux-arm64.rpm', type: 'application/x-rpm' }
}

/**
 * An address as it compares: an IPv4 socket seen through IPv6 carries a `::ffff:` prefix, and a
 * forwarded header may carry anything at all.
 */
function plainAddress(value) {
  return String(value ?? '').trim().toLowerCase().replace(/^::ffff:/, '')
}

function cleanOrigin(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('PUBLIC_ORIGIN must use HTTPS.')
  return url.origin
}

function json(response, status, body) {
  const payload = JSON.stringify(body)
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload), 'Cache-Control': 'no-store' })
  response.end(payload)
}

function safeEqual(left, right) {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

async function bodyJson(request) {
  const chunks = []
  let length = 0
  for await (const chunk of request) {
    length += chunk.length
    if (length > 16 * 1024) throw new Error('Request too large.')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

function page(locale, entry, { before = '', after = '' } = {}) {
  const strings = AUTH[locale] ?? AUTH[DEFAULT_LOCALE]
  const copy = entry.copy ? `<p>${entry.copy}</p>` : ''
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>${entry.title} · Twichat</title><link rel="stylesheet" href="/auth.css"></head><body class="auth-page"><main class="auth-card"><img src="/assets/twichat-logo.png" width="72" height="72" alt=""><p class="kicker">${strings.kicker}</p>${before}<h1>${entry.heading}</h1>${copy}${after}</main></body></html>`
}

function sendHtml(response, status, html, cache = 'no-store') {
  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html), 'Cache-Control': cache })
  response.end(html)
}

async function twitchToken(fetcher, tokenUrl, parameters) {
  const response = await fetcher(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(parameters),
    signal: AbortSignal.timeout(10_000)
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok || typeof result.access_token !== 'string') {
    // A 4xx is Twitch turning this credential down — a spent code, a revoked renewal session.
    // A 5xx or a timeout is the road to Twitch, and says nothing about the credential itself.
    // The application forgets an account on the first and waits on the second, so the two must
    // not reach it under the same name.
    throw Object.assign(new Error('Twitch refused this sign-in.'), { refused: response.status >= 400 && response.status < 500 })
  }
  return result
}

async function validateTwitchToken(fetcher, validateUrl, token) {
  const response = await fetcher(validateUrl, { headers: { Authorization: `OAuth ${token}` }, signal: AbortSignal.timeout(10_000) })
  const result = await response.json().catch(() => ({}))
  if (!response.ok || typeof result.login !== 'string' || !requiredScopes.every(scope => result.scopes?.includes(scope))) {
    throw new Error('The Twitch account does not grant the scopes the chat needs.')
  }
  return result.login.toLowerCase()
}

export function createTwichatServer(overrides = {}) {
  const env = overrides.env ?? process.env
  const publicOrigin = cleanOrigin(overrides.publicOrigin ?? env.PUBLIC_ORIGIN ?? 'http://127.0.0.1:3000')
  const clientId = overrides.clientId ?? env.TWITCH_CLIENT_ID ?? ''
  const clientSecret = overrides.clientSecret ?? env.TWITCH_CLIENT_SECRET ?? ''
  const publicDirectory = overrides.publicDirectory ?? defaultPublicDirectory
  // One page per language, built once and kept in memory: nothing to recompute per request.
  const localisedPages = buildPages(publicDirectory, publicOrigin)
  const siteMap = sitemap(publicOrigin)
  const notFoundPages = buildNotFound(publicDirectory)
  const fetcher = overrides.fetch ?? globalThis.fetch
  const authorizeUrl = overrides.authorizeUrl ?? 'https://id.twitch.tv/oauth2/authorize'
  const tokenUrl = overrides.tokenUrl ?? 'https://id.twitch.tv/oauth2/token'
  const validateUrl = overrides.validateUrl ?? 'https://id.twitch.tv/oauth2/validate'
  const redirectUri = `${publicOrigin}/auth/callback`
  // A forwarded address is believed only when the connection itself comes from a proxy named
  // here. `X-Forwarded-For` is a request header like any other: without this, a client picked
  // its own rate-limit bucket by rewriting one line, and the limit stopped nobody.
  const trustedProxies = new Set(String(overrides.trustedProxies ?? env.TWICHAT_TRUSTED_PROXIES ?? '').split(',').map(plainAddress).filter(Boolean))
  // A sign-in in flight and a ticket waiting to be claimed both live a few minutes. This ceiling
  // bounds what a flood holds at once. A full table refuses the newcomer rather than evicting an
  // older entry: evicting would hand an attacker a way to cancel other people's sign-ins.
  const maxSessions = Number(overrides.maxSessions ?? env.TWICHAT_MAX_SESSIONS ?? 2000)
  const pending = new Map()
  const tickets = new Map()
  const attempts = new Map()

  function configured() { return Boolean(clientId && clientSecret) }
  function cleanup() {
    const now = Date.now()
    for (const [key, value] of pending) if (value.expires < now) pending.delete(key)
    for (const [key, value] of tickets) if (value.expires < now) tickets.delete(key)
    for (const [key, value] of attempts) if (value.reset < now) attempts.delete(key)
  }
  /** The address the limit counts against: the socket's, unless a trusted proxy named another. */
  function clientAddress(request) {
    const socketAddress = plainAddress(request.socket.remoteAddress)
    if (!trustedProxies.has(socketAddress)) return socketAddress
    // The rightmost entry is the one the trusted proxy appended; everything left of it is
    // whatever the client chose to claim.
    const forwarded = String(request.headers['x-forwarded-for'] ?? '').split(',').map(plainAddress).filter(Boolean)
    return forwarded.at(-1) ?? socketAddress
  }
  function limited(request) {
    const key = clientAddress(request)
    const current = attempts.get(key)
    const now = Date.now()
    if (!current || current.reset < now) { attempts.set(key, { count: 1, reset: now + 60_000 }); return false }
    current.count++
    return current.count > 30
  }
  // The error page lives in `public/` like the rest of the site: same stylesheet, same
  // theme, and the language of the requested prefix — `/en/nothing` answers in English.
  function notFound(response, pathname = '') {
    const locale = LOCALES.find(entry => pathname.startsWith(`/${entry}/`)) ?? DEFAULT_LOCALE
    try {
      const html = notFoundPages[locale]
      response.writeHead(404, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(html),
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, follow'
      })
      return response.end(html)
    } catch {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('Page not found')
    }
  }

  async function staticFile(response, pathname) {
    const requested = pathname === '/' ? '/index.html' : pathname
    try {
      // Decoding belongs inside the guard: `/%` is a path the decoder refuses, not a failure.
      const relative = normalize(decodeURIComponent(requested)).replace(/^(\.\.(\/|\\|$))+/, '').replace(/^[/\\]+/, '')
      const path = join(publicDirectory, relative)
      const information = await stat(path)
      if (!information.isFile()) return false
      response.writeHead(200, {
        'Content-Type': mimeTypes.get(extname(path)) ?? 'application/octet-stream',
        'Content-Length': information.size,
        'Cache-Control': requested === '/index.html' ? 'no-cache' : 'public, max-age=86400'
      })
      // A file that fails mid-send closes the connection: an unhandled stream error on a
      // response whose headers already left would otherwise take the whole process down.
      const stream = createReadStream(path)
      stream.on('error', () => response.destroy())
      stream.pipe(response)
      return true
    } catch { return false }
  }

  const server = createServer(async (request, response) => {
    cleanup()
    // HEAD follows the same routes as GET: Node takes care of omitting the body.
    const readMethod = request.method === 'GET' || request.method === 'HEAD'
    response.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('X-Frame-Options', 'DENY')
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    if (publicOrigin.startsWith('https:')) response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    let url
    try { url = new URL(request.url ?? '/', publicOrigin) }
    catch {
      // A request line the parser refuses — `GET http://[` — threw straight out of this
      // callback, and an exception here ends the process rather than the request.
      const body = 'Invalid request'
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
      return response.end(body)
    }
    if (url.pathname === '/download' || url.pathname.startsWith('/auth/')) response.setHeader('X-Robots-Tag', 'noindex, nofollow')

    try {
      // The root goes to the default language. A fixed, unnegotiated redirect: the page
      // stays cacheable, and a shared link always opens the language it names.
      if (readMethod && (url.pathname === '/' || url.pathname === '/index.html')) {
        response.writeHead(302, { Location: `/${DEFAULT_LOCALE}/`, 'Cache-Control': 'no-cache' })
        return response.end()
      }
      const localeMatch = /^\/([a-z]{2})(\/?)$/.exec(url.pathname)
      if (readMethod && localeMatch && LOCALES.includes(localeMatch[1])) {
        // One address per language: `/fr` redirects to `/fr/`, never two URLs for one page.
        if (!localeMatch[2]) {
          response.writeHead(301, { Location: `/${localeMatch[1]}/` })
          return response.end()
        }
        return sendHtml(response, 200, localisedPages[localeMatch[1]], 'public, max-age=300')
      }
      if (readMethod && url.pathname === '/sitemap.xml') {
        response.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Content-Length': Buffer.byteLength(siteMap), 'Cache-Control': 'public, max-age=3600' })
        return response.end(siteMap)
      }
      if (readMethod && url.pathname === '/healthz') return json(response, 200, { ok: true })
      if (readMethod && url.pathname === '/api/status') {
        return json(response, 200, { authentication: configured(), platforms: Object.keys(downloadFiles) })
      }
      if (request.method === 'GET' && url.pathname === '/auth/start') {
        // The language travels with the request: Twitch redirects back here knowing nothing of it.
        const locale = pickLocale(url.searchParams.get('lang'))
        // Starting a sign-in counts against the same budget as claiming one: unmetered, it let
        // a single client open sessions by the thousand and pay nothing for them.
        if (limited(request)) return sendHtml(response, 429, page(locale, AUTH[locale].busy))
        if (!configured()) return sendHtml(response, 503, page(locale, AUTH[locale].notConfigured))
        const challenge = url.searchParams.get('challenge') ?? ''
        if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) return sendHtml(response, 400, page(locale, AUTH[locale].invalidLink))
        if (pending.size >= maxSessions) return sendHtml(response, 503, page(locale, AUTH[locale].busy))
        const state = randomBytes(32).toString('base64url')
        pending.set(state, { challenge, locale, expires: Date.now() + 10 * 60_000 })
        const destination = new URL(authorizeUrl)
        destination.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: loginScopes.join(' '), state, force_verify: 'true' }).toString()
        response.writeHead(302, { Location: destination.href, 'Cache-Control': 'no-store' })
        return response.end()
      }
      if (request.method === 'GET' && url.pathname === '/auth/callback') {
        const state = url.searchParams.get('state') ?? ''
        const requestState = pending.get(state)
        pending.delete(state)
        const locale = requestState?.locale ?? DEFAULT_LOCALE
        if (!requestState || requestState.expires < Date.now()) return sendHtml(response, 400, page(locale, AUTH[locale].expired))
        if (url.searchParams.has('error')) return sendHtml(response, 400, page(locale, AUTH[locale].cancelled))
        const code = url.searchParams.get('code') ?? ''
        if (!/^[A-Za-z0-9_-]{8,512}$/.test(code)) return sendHtml(response, 400, page(locale, AUTH[locale].invalidCode))
        if (tickets.size >= maxSessions) return sendHtml(response, 503, page(locale, AUTH[locale].busy))
        const token = await twitchToken(fetcher, tokenUrl, { client_id: clientId, client_secret: clientSecret, code, grant_type: 'authorization_code', redirect_uri: redirectUri })
        const login = await validateTwitchToken(fetcher, validateUrl, token.access_token)
        const ticket = randomBytes(32).toString('base64url')
        tickets.set(ticket, { challenge: requestState.challenge, locale, accessToken: token.access_token, refreshToken: token.refresh_token, login, expires: Date.now() + 2 * 60_000, failures: 0 })
        response.writeHead(303, { Location: `/auth/complete?ticket=${ticket}`, 'Cache-Control': 'no-store' })
        return response.end()
      }
      if (request.method === 'GET' && url.pathname === '/auth/complete') {
        const ticket = url.searchParams.get('ticket') ?? ''
        const claimed = tickets.get(ticket)
        const locale = claimed?.locale ?? pickLocale(url.searchParams.get('lang'))
        if (!/^[A-Za-z0-9_-]{43}$/.test(ticket) || !claimed) return sendHtml(response, 400, page(locale, AUTH[locale].ticketExpired))
        return sendHtml(response, 200, page(locale, AUTH[locale].complete, {
          before: `<span class="auth-ok">${AUTH[locale].authorized}</span>`,
          after: `<a class="auth-button" data-open-app href="twichat://auth?ticket=${ticket}">${AUTH[locale].backToApp}</a><script src="/auth-complete.js" defer></script>`
        }))
      }
      if (request.method === 'POST' && url.pathname === '/auth/claim') {
        if (limited(request)) return json(response, 429, { key: 'authRateLimited', error: 'Too many attempts. Try again in a minute.' })
        const input = await bodyJson(request)
        const ticket = typeof input.ticket === 'string' ? input.ticket : ''
        const verifier = typeof input.verifier === 'string' ? input.verifier : ''
        const claim = tickets.get(ticket)
        if (!claim || claim.expires < Date.now() || !/^[A-Za-z0-9_-]{43}$/.test(verifier)) return json(response, 400, { key: 'authExpired', error: 'This sign-in has expired.' })
        const challenge = createHash('sha256').update(verifier).digest('base64url')
        if (!safeEqual(challenge, claim.challenge)) {
          claim.failures++
          if (claim.failures >= 3) tickets.delete(ticket)
          return json(response, 403, { key: 'authDeviceMismatch', error: 'This sign-in does not match this device.' })
        }
        tickets.delete(ticket)
        return json(response, 200, { accessToken: claim.accessToken, refreshToken: claim.refreshToken, login: claim.login })
      }
      if (request.method === 'POST' && url.pathname === '/auth/refresh') {
        if (!configured()) return json(response, 503, { key: 'authUnavailable', error: 'Twitch sign-in is unavailable.' })
        if (limited(request)) return json(response, 429, { key: 'authRateLimited', error: 'Too many attempts. Try again in a minute.' })
        const input = await bodyJson(request)
        const refreshToken = typeof input.refreshToken === 'string' ? input.refreshToken : ''
        if (!refreshToken || refreshToken.length > 4096) return json(response, 400, { key: 'authRefreshInvalid', error: 'Invalid renewal session.' })
        let token
        try { token = await twitchToken(fetcher, tokenUrl, { client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken }) }
        catch (error) {
          if (!error?.refused) throw error
          return json(response, 401, { key: 'authRefreshRejected', error: 'Twitch turned this renewal down.' })
        }
        await validateTwitchToken(fetcher, validateUrl, token.access_token)
        return json(response, 200, { accessToken: token.access_token, refreshToken: token.refresh_token ?? refreshToken })
      }
      if (readMethod && url.pathname === '/download') {
        const platform = Object.hasOwn(downloadFiles, url.searchParams.get('platform')) ? url.searchParams.get('platform') : 'mac'
        const file = downloadFiles[platform]
        const external = env[`TWICHAT_DOWNLOAD_${platform.toUpperCase()}_URL`]
        if (external) { response.writeHead(302, { Location: new URL(external).href }); return response.end() }
        const path = join(publicDirectory, 'downloads', file.name)
        try {
          await access(path)
          const information = await stat(path)
          response.writeHead(200, { 'Content-Type': file.type, 'Content-Length': information.size, 'Content-Disposition': `attachment; filename="${file.name}"`, 'Cache-Control': 'no-store' })
          const stream = createReadStream(path)
          stream.on('error', () => response.destroy())
          return stream.pipe(response)
        } catch {
          const locale = pickLocale(url.searchParams.get('lang'))
          return sendHtml(response, 503, page(locale, AUTH[locale].downloadSoon, { after: `<a class="auth-button" href="/${locale}/">${AUTH[locale].backToSite}</a>` }))
        }
      }
      if (readMethod && await staticFile(response, url.pathname)) return
      return notFound(response, url.pathname)
    } catch (error) {
      console.error('Request failed:', error instanceof Error ? error.message : error)
      if (!response.headersSent) {
        if (url.pathname.startsWith('/auth/') && request.method === 'POST') return json(response, 502, { key: 'twitchUnresponsive', error: 'Twitch is not responding properly. Try again.' })
        const locale = LOCALES.find(entry => url.pathname.startsWith(`/${entry}/`)) ?? pickLocale(url.searchParams.get('lang'))
        return sendHtml(response, 502, page(locale, AUTH[locale].unreachable))
      }
      response.end()
    }
  })

  return server
}


