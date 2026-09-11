import assert from 'node:assert/strict'
import { once } from 'node:events'
import { chromium, devices } from 'playwright'
import { createTwichatServer } from '../server/app.mjs'
import { CONTENT, contentPath } from '../server/site-content.mjs'

const server = createTwichatServer()
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const origin = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  for (const locale of ['fr', 'en']) for (const colorScheme of ['dark', 'light']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`) })
    for (const entry of CONTENT) {
      await page.goto(`${origin}${contentPath(entry, locale)}`)
      assert.equal(await page.locator('h1').count(), 1)
      const other = locale === 'fr' ? 'en' : 'fr'
      assert.equal(await page.locator('.lang-switch a').getAttribute('href'), contentPath(entry, other))
      // Every fragment must name an element on its destination page.
      const fragments = await page.locator('a[href^="#"]').evaluateAll(links => links.map(link => link.hash.slice(1)))
      for (const id of fragments) assert.equal(await page.locator(`[id="${id}"]`).count(), 1, `${entry.key}: missing #${id}`)
      for (const width of [320, 390, 768, 1024, 1440]) {
        await page.setViewportSize({ width, height: 900 })
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${entry.key} overflows at ${width}`)
      }
      if (entry.article) {
        await page.locator('.reading-figure').scrollIntoViewIfNeeded()
        await page.locator('.reading-figure img').evaluate(img => img.decode())
        assert.equal(await page.locator('.reading-figure img').evaluate(img => img.currentSrc.includes('-light.')), colorScheme === 'light')
        await page.locator('#theme-toggle').click()
        await page.locator('.reading-figure img').evaluate(img => img.decode())
        assert.equal(await page.locator('.reading-figure img').evaluate(img => img.currentSrc.includes('-light.')), colorScheme !== 'light')
      }
    }
    assert.deepEqual(errors, [])
    await context.close()
    console.log(`✓ ${locale}/${colorScheme}: six content pages, five widths, links and theme`)
  }
  const phone = await browser.newContext(devices['iPhone 13'])
  const mobile = await phone.newPage()
  await mobile.goto(`${origin}${contentPath(CONTENT.find(entry => entry.article), 'fr')}`)
  assert.equal(await mobile.locator('.nav-download').getAttribute('href'), '/fr/#download-title')
  await phone.close()
  const noJS = await browser.newContext({ javaScriptEnabled: false })
  const page = await noJS.newPage()
  await page.goto(`${origin}${contentPath(CONTENT.find(entry => entry.article), 'fr')}`)
  assert.ok((await page.locator('article').innerText()).includes('fenêtre séparée'))
  await noJS.close()
} finally { await browser.close(); server.close() }
