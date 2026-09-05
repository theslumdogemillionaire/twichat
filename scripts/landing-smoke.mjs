import assert from 'node:assert/strict'
import { once } from 'node:events'
import { chromium } from 'playwright'
import { createTwichatServer } from '../server/app.mjs'

// Uses the installed Chrome, like the browser used for visual review. No Electron build needed.
const server = createTwichatServer()
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const origin = `http://127.0.0.1:${server.address().port}`
let browser
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  for (const locale of ['fr', 'en']) {
    for (const colorScheme of ['dark', 'light']) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme, reducedMotion: 'reduce' })
      const errors = []
      page.on('pageerror', error => errors.push(error.message))
      page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`) })
      await page.goto(`${origin}/${locale}/`)
      await page.evaluate(() => document.fonts.ready)
      const shots = page.locator('[data-screenshot]')
      assert.equal(await shots.count(), 6)
      // One theme at a time: every card in the strip, and every image the dialog opens, shows
      // the theme being read — never the other one.
      const suffix = colorScheme === 'light' ? '-light.' : '.'
      // The thumbnail is read from the `<source>` left active, not from `currentSrc`: the strip
      // sits below the fold and its lazy images have not loaded yet at this point.
      const showing = await shots.evaluateAll(links => links.flatMap(link => [
        link.getAttribute('href'),
        [...link.querySelectorAll('source')].find(source => source.media !== 'not all').srcset
      ]))
      for (const value of showing) {
        assert.equal(value.includes('-light.'), colorScheme === 'light', `${value} does not follow the ${colorScheme} theme`)
      }
      for (let index = 0; index < 6; index++) {
        const shot = shots.nth(index)
        await shot.scrollIntoViewIfNeeded()
        await shot.locator('img').evaluate(img => img.decode())
        assert.ok((await shot.getAttribute('href')).includes(`${suffix}${locale}.png`))
        // The alt is the link's description, so it reaches a screen reader alongside the title.
        const described = await shot.getAttribute('aria-describedby')
        assert.equal(described, await shot.locator('img').getAttribute('id'))
        assert.ok((await shot.locator('img').getAttribute('alt')).length > 40, 'each capture needs a real alt')
        await shot.click()
        const modal = page.locator('#screenshot-lightbox')
        assert.equal(await modal.evaluate(node => node.open), true)
        await page.locator('.lightbox-image').evaluate(img => img.decode())
        assert.equal(await page.locator('.lightbox-image').getAttribute('alt'), await shot.locator('img').getAttribute('alt'))
        assert.equal(await page.locator('.lightbox-close').evaluate(node => node === document.activeElement), true)
        await page.keyboard.press('Shift+Tab')
        assert.equal(await page.locator('.lightbox-zoom').evaluate(node => node === document.activeElement), true)
        for (let n = 0; n < 8; n++) {
          await page.keyboard.press('Tab')
          assert.equal(await modal.evaluate(node => node.contains(document.activeElement)), true, 'focus must stay in modal')
        }
        await page.locator('.lightbox-close').click()
        assert.equal(await shot.evaluate(node => node === document.activeElement), true, 'return focus to opener')
      }
      await shots.first().scrollIntoViewIfNeeded()
      await shots.first().click()
      await page.keyboard.press('ArrowLeft')
      assert.equal(await page.locator('.lightbox-count').textContent(), '6 / 6')
      await page.keyboard.press('ArrowRight')
      assert.equal(await page.locator('.lightbox-count').textContent(), '1 / 6')
      await page.locator('[data-lightbox-next]').click()
      assert.equal(await page.locator('.lightbox-count').textContent(), '2 / 6')
      await page.locator('[data-lightbox-prev]').click()
      await page.locator('.lightbox-zoom').click()
      assert.equal(await page.locator('.lightbox-zoom').getAttribute('aria-pressed'), 'true')
      await page.keyboard.press('Escape')
      assert.equal(await page.locator('#screenshot-lightbox').evaluate(node => node.open), false)
      await page.waitForFunction(() => !document.documentElement.classList.contains('lightbox-open'))
      assert.equal(await page.evaluate(() => document.documentElement.classList.contains('lightbox-open')), false)
      await shots.first().scrollIntoViewIfNeeded()
      await shots.first().click()
      await page.mouse.click(5, 5)
      assert.equal(await page.locator('#screenshot-lightbox').evaluate(node => node.open), false, 'backdrop closes preview')
      await page.locator('#screenshot-strip').evaluate(node => node.scrollTo({ left: 0, behavior: 'instant' }))
      await page.locator('[data-gallery-next]').click()
      await page.waitForFunction(() => document.getElementById('screenshot-strip').scrollLeft > 100)
      await page.locator('[data-gallery-prev]').click()
      await page.waitForFunction(() => document.getElementById('screenshot-strip').scrollLeft < 2)

      for (const width of [320, 390, 768, 1024, 1440]) {
        await page.setViewportSize({ width, height: 844 })
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `page overflows at ${width}`)
        await shots.first().scrollIntoViewIfNeeded()
        await shots.first().click()
        await page.locator('.lightbox-image').evaluate(img => img.decode())
        const fits = await page.locator('.lightbox-image').evaluate(img => {
          const a = img.getBoundingClientRect(), b = img.parentElement.getBoundingClientRect()
          return a.width <= b.width + 1 && a.height <= b.height + 1
        })
        assert.equal(fits, true, `image must fit at ${width}`)
        await page.locator('.lightbox-zoom').click()
        assert.equal(await page.locator('.lightbox-image').evaluate(img => img.getBoundingClientRect().width >= 1320), true)
        await page.locator('.lightbox-zoom').click()
        assert.equal(await page.locator('.lightbox-zoom').getAttribute('aria-pressed'), 'false')
        await page.keyboard.press('Escape')
        await page.waitForFunction(() => !document.documentElement.classList.contains('lightbox-open'))
      }
      assert.deepEqual(errors, [], `${locale}/${colorScheme}: browser errors`)
      await page.close()
      console.log(`✓ ${locale}/${colorScheme}: six captures in the ${colorScheme} theme, keyboard, focus, zoom, backdrop, strip and five viewport widths`)
    }
  }
  const noJS = await browser.newPage({ javaScriptEnabled: false })
  await noJS.goto(`${origin}/fr/`)
  const target = await noJS.locator('[data-screenshot]').first().getAttribute('href')
  await noJS.locator('[data-screenshot]').first().click()
  assert.equal(noJS.url(), `${origin}${target}`, 'without JS, link opens the original image')
  console.log('✓ No JavaScript: original images remain accessible')
} finally {
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
}
