import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { connect } from 'node:net'
import { createTwichatServer } from '../server/app.mjs'
import { LOCALES } from '../server/site-messages.mjs'

/** The origin the test server announces: the canonicals and alternates carry it. */
const PUBLIC = 'http://127.0.0.1:3000'

async function runningServer(options = {}) {
  const calls = []
  const fakeFetch = async (url, request = {}) => {
    calls.push({ url: String(url), request })
    if (String(url).endsWith('/token')) return Response.json({ access_token: 'access-token-from-twitch', refresh_token: 'refresh-token-from-twitch' })
    if (String(url).endsWith('/validate')) return Response.json({ login: 'Alice', scopes: ['chat:read', 'chat:edit'] })
    return new Response(null, { status: 404 })
  }
  const server = createTwichatServer({
    publicOrigin: 'http://127.0.0.1:3000', clientId: 'client-id', clientSecret: 'client-secret',
    authorizeUrl: 'https://id.example/authorize', tokenUrl: 'https://id.example/token', validateUrl: 'https://id.example/validate',
    fetch: fakeFetch, ...options
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  return { server, calls, origin: `http://127.0.0.1:${address.port}` }
}

test('serves the landing page and exposes a health check', async t => {
  const context = await runningServer()
  t.after(() => context.server.close())
  const health = await fetch(`${context.origin}/healthz`)
  assert.deepEqual(await health.json(), { ok: true })
  // The root no longer serves a page: it sends visitors to the default language, without negotiating.
  const root = await fetch(`${context.origin}/`, { redirect: 'manual' })
  assert.equal(root.status, 302)
  assert.equal(root.headers.get('location'), '/en/')
  // A single address per language: the slashless variant redirects permanently.
  const bare = await fetch(`${context.origin}/fr`, { redirect: 'manual' })
  assert.equal(bare.status, 301)
  assert.equal(bare.headers.get('location'), '/fr/')

  const landing = await fetch(`${context.origin}/fr/`)
  assert.equal(landing.status, 200)
  const html = await landing.text()
  assert.match(html, /dans une seule fenêtre/)
  assert.match(html, /<meta name="robots" content="index,follow/)
  assert.match(html, /<html lang="fr"/)
  const structuredData = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1]
  assert.ok(structuredData)
  const graph = JSON.parse(structuredData)['@graph']
  assert.ok(graph.some(entity => entity['@type'] === 'SoftwareApplication' && entity.name === 'Twichat'))
  const faq = graph.find(entity => entity['@type'] === 'FAQPage')
  assert.equal(faq.mainEntity.length, 6)
  for (const question of faq.mainEntity) {
    assert.match(html, new RegExp(question.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(html, new RegExp(question.acceptedAnswer.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  assert.match(landing.headers.get('content-security-policy'), /frame-ancestors 'none'/)

  const sitemap = await fetch(`${context.origin}/sitemap.xml`)
  assert.match(sitemap.headers.get('content-type'), /application\/xml/)
  const sitemapText = await sitemap.text()
  // Both languages are declared, each pointing at the other, plus `x-default`.
  for (const locale of ['en', 'fr']) {
    assert.ok(sitemapText.includes(`<loc>${PUBLIC}/${locale}/</loc>`), `sitemap without ${locale}`)
    assert.ok(sitemapText.includes(`hreflang="${locale}" href="${PUBLIC}/${locale}/"`))
  }
  assert.ok(sitemapText.includes(`hreflang="x-default" href="${PUBLIC}/en/"`))
  const robots = await fetch(`${context.origin}/robots.txt`)
  const robotsText = await robots.text()
  assert.match(robotsText, /Sitemap: https:\/\/twichat\.theslumdogemillionaire\.com\/sitemap\.xml/)
  assert.match(robotsText, /Disallow: \/auth\//)

  // The theme toggle writes its own tooltip, after the build has translated the markup: it
  // carries its own table, so every served language needs an entry there too.
  const theme = await (await fetch(`${context.origin}/theme.js`)).text()
  for (const locale of LOCALES) {
    assert.match(theme, new RegExp(`\\b${locale}: \\{ system:`), `theme.js carries no label for ${locale}`)
  }

  // Screenshots are checked exactly as the page asks for them, language by language: adding
  // a language without rerunning `site:capture` breaks here, not silently for the visitor.
  for (const locale of LOCALES) {
    const page = await (await fetch(`${context.origin}/${locale}/`)).text()
    const referenced = [...page.matchAll(/(?:href|src|srcset)="(\/assets\/app-[^"?]+)(?:\?[^"]*)?"/g)].map(match => match[1])
    assert.ok(referenced.length >= 2, `no screenshot referenced in ${locale}`)
    for (const asset of new Set(referenced)) {
      const image = await fetch(`${context.origin}${asset}`)
      assert.equal(image.status, 200, `${asset} missing for ${locale}`)
      assert.match(image.headers.get('content-type'), /^image\//, `${asset} is not an image`)
    }
  }
  const themeScript = await fetch(`${context.origin}/theme.js`)
  assert.match(themeScript.headers.get('content-type'), /text\/javascript/)
  const download = await fetch(`${context.origin}/download`)
  assert.equal(download.headers.get('x-robots-tag'), 'noindex, nofollow')
  const head = await fetch(`${context.origin}/`, { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(head.headers.get('content-type'), 'text/html; charset=utf-8')
})

test('exchanges a Twitch code for a single-use ticket bound to the device', async t => {
  const context = await runningServer()
  t.after(() => context.server.close())
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')

  const start = await fetch(`${context.origin}/auth/start?challenge=${challenge}`, { redirect: 'manual' })
  assert.equal(start.status, 302)
  const authorization = new URL(start.headers.get('location'))
  assert.equal(authorization.origin, 'https://id.example')
  assert.equal(authorization.searchParams.get('scope'), 'chat:read chat:edit user:read:follows')
  assert.equal(authorization.searchParams.get('force_verify'), 'true')
  const state = authorization.searchParams.get('state')

  const callback = await fetch(`${context.origin}/auth/callback?code=valid-code&state=${state}`, { redirect: 'manual' })
  assert.equal(callback.status, 303)
  const ticket = new URL(callback.headers.get('location'), context.origin).searchParams.get('ticket')
  assert.match(ticket, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(context.calls.length, 2)

  const claim = await fetch(`${context.origin}/auth/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket, verifier }) })
  assert.equal(claim.status, 200)
  assert.deepEqual(await claim.json(), { accessToken: 'access-token-from-twitch', refreshToken: 'refresh-token-from-twitch', login: 'alice' })
  const repeated = await fetch(`${context.origin}/auth/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket, verifier }) })
  assert.equal(repeated.status, 400)
})

test('refreshes a Twitch session server-side', async t => {
  const context = await runningServer()
  t.after(() => context.server.close())
  const response = await fetch(`${context.origin}/auth/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: 'old-refresh-token' }) })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { accessToken: 'access-token-from-twitch', refreshToken: 'refresh-token-from-twitch' })
  const body = context.calls[0].request.body
  assert.equal(body.get('grant_type'), 'refresh_token')
  assert.equal(body.get('refresh_token'), 'old-refresh-token')
})

test('each language has its route, its alternates and its structured data', async t => {
  const context = await runningServer()
  t.after(() => context.server.close())

  const pages = Object.fromEntries(await Promise.all(['en', 'fr'].map(async locale =>
    [locale, await (await fetch(`${context.origin}/${locale}/`)).text()])))

  for (const [locale, html] of Object.entries(pages)) {
    assert.match(html, new RegExp(`<html lang="${locale}"`))
    // The canonical names the page itself, never the root nor the other language.
    assert.ok(html.includes(`<link rel="canonical" href="${PUBLIC}/${locale}/">`), `wrong canonical in ${locale}`)
    for (const other of ['en', 'fr']) {
      assert.ok(html.includes(`<link rel="alternate" hreflang="${other}" href="${PUBLIC}/${other}/">`), `alternate ${other} missing in ${locale}`)
    }
    // `x-default` points at the page the root redirect serves.
    assert.ok(html.includes(`hreflang="x-default" href="${PUBLIC}/en/"`))
    assert.ok(html.includes(`<meta property="og:url" content="${PUBLIC}/${locale}/">`))
    // Structured data follows the language: that is what search engines read.
    const graph = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1])['@graph']
    for (const entity of graph.filter(item => item.inLanguage)) {
      assert.equal(entity.inLanguage, locale === 'fr' ? 'fr-FR' : 'en-US')
    }
    // Every JSON-LD question must exist verbatim in the page of the same language.
    for (const question of graph.find(item => item['@type'] === 'FAQPage').mainEntity) {
      assert.match(html, new RegExp(question.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    }
  }

  // The English page must no longer carry French, nor the other way around.
  for (const french of ['Pourquoi Twichat', 'Chaque chaîne', 'Comment ça marche', 'Le chat tient dans une colonne']) {
    assert.ok(!pages.en.includes(french), `"${french}" still present in /en/`)
  }
  for (const english of ['Why Twichat', 'How it works', 'Chat fits in a column']) {
    assert.ok(!pages.fr.includes(english), `"${english}" still present in /fr/`)
    assert.ok(pages.en.includes(english), `"${english}" missing from /en/`)
  }
  // The switcher marks the language being read and links to the other one; the banner starts
  // hidden: the script decides.
  assert.match(pages.en, /class="lang-switch"[\s\S]{0,400}<span aria-current="page" lang="en">EN<\/span>/)
  assert.match(pages.en, /class="lang-switch"[\s\S]{0,400}href="\/fr\/" hreflang="fr" lang="fr"[^>]*>FR</)
  assert.match(pages.fr, /class="lang-switch"[\s\S]{0,400}<span aria-current="page" lang="fr">FR<\/span>/)
  assert.match(pages.fr, /class="lang-switch"[\s\S]{0,400}href="\/en\/" hreflang="en" lang="en"[^>]*>EN</)
  assert.match(pages.en, /id="lang-banner"[^>]*hidden/)
})

/** Sends a request line the URL parser refuses — `fetch` cannot build one. */
async function rawRequest(origin, requestLine) {
  const socket = connect(Number(new URL(origin).port), '127.0.0.1')
  await once(socket, 'connect')
  socket.write(`${requestLine} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`)
  let answer = ''
  socket.on('data', chunk => { answer += chunk })
  await once(socket, 'close')
  return answer.split('\r\n')[0]
}

test('a request the URL parser refuses is answered, not fatal', async t => {
  const context = await runningServer()
  t.after(() => context.server.close())
  // `new URL(request.url, origin)` used to run outside the guard: this line took the process down.
  assert.match(await rawRequest(context.origin, 'GET http://['), /^HTTP\/1\.1 400 /)
  // What matters is the next request: the server is still there to answer it.
  const health = await fetch(`${context.origin}/healthz`)
  assert.deepEqual(await health.json(), { ok: true })
  // A path whose escaping cannot be decoded is a missing resource, not a server failure.
  const undecodable = await fetch(`${context.origin}/%`)
  assert.equal(undecodable.status, 404)
})

test('the rate limit counts the socket, not a header the client writes', async t => {
  const context = await runningServer()
  t.after(() => context.server.close())
  const claim = (headers = {}) => fetch(`${context.origin}/auth/claim`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ ticket: 'x', verifier: 'y' })
  })

  let status = 0
  for (let attempt = 0; attempt < 31 && status !== 429; attempt++) status = (await claim()).status
  assert.equal(status, 429)
  // Nothing in front of this server is trusted, so a forwarded address buys no fresh budget.
  assert.equal((await claim({ 'X-Forwarded-For': '203.0.113.7' })).status, 429)
  assert.equal((await claim({ 'X-Forwarded-For': '203.0.113.8, 198.51.100.1' })).status, 429)
})

test('behind a declared proxy, the counted address is the one the proxy appended', async t => {
  const context = await runningServer({ trustedProxies: '127.0.0.1' })
  t.after(() => context.server.close())
  const claim = forwarded => fetch(`${context.origin}/auth/claim`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': forwarded }, body: JSON.stringify({ ticket: 'x', verifier: 'y' })
  })

  let status = 0
  for (let attempt = 0; attempt < 31 && status !== 429; attempt++) status = (await claim('203.0.113.7, 198.51.100.1')).status
  assert.equal(status, 429)
  // The entry on the left is the client's own claim: changing it must not open a new bucket.
  assert.equal((await claim('203.0.113.9, 198.51.100.1')).status, 429)
  // A different address from the proxy is a different visitor, and keeps its own budget.
  assert.equal((await claim('203.0.113.7, 198.51.100.2')).status, 400)
})

test('a flood of sign-ins fills a bounded table and is turned away', async t => {
  const context = await runningServer({ maxSessions: 2 })
  t.after(() => context.server.close())
  const start = () => fetch(`${context.origin}/auth/start?challenge=${randomBytes(32).toString('base64url')}`, { redirect: 'manual' })

  assert.equal((await start()).status, 302)
  assert.equal((await start()).status, 302)
  // The table is full: the newcomer is refused rather than an earlier sign-in being evicted.
  const refused = await start()
  assert.equal(refused.status, 503)
  assert.match(await refused.text(), /Too many sign-ins/)
})

test('a renewal Twitch turns down is named apart from a Twitch that is out', async t => {
  const refuse = async () => Response.json({ error: 'invalid_grant' }, { status: 400 })
  const refused = await runningServer({ fetch: refuse })
  t.after(() => refused.server.close())
  const post = origin => fetch(`${origin}/auth/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: 'revoked' }) })

  // Twitch saying no to a renewal session ends it: the application forgets the account on this.
  const answer = await post(refused.origin)
  assert.equal(answer.status, 401)
  assert.equal((await answer.json()).key, 'authRefreshRejected')

  // The road to Twitch being out says nothing about the credential, and must not read the same:
  // the application waits on this one and keeps the account.
  const outage = await runningServer({ fetch: async () => new Response(null, { status: 503 }) })
  t.after(() => outage.server.close())
  const waiting = await post(outage.origin)
  assert.equal(waiting.status, 502)
  assert.equal((await waiting.json()).key, 'twitchUnresponsive')
})
