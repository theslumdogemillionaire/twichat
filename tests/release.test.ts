import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const read = (path: string) => readFileSync(join(root, path), 'utf8')

/** Runs the gate the way the workflow does, and reports what the runner would see. */
function gate(ref: string) {
  try { return { code: 0, output: execFileSync('node', ['scripts/release-gate.mjs', ref], { cwd: root, encoding: 'utf8' }).trim() } }
  catch (error) { const failure = error as { status: number; stdout: string }; return { code: failure.status, output: failure.stdout.trim() } }
}

test('a tag naming the packaged version is what a release is built from', () => {
  const { version } = JSON.parse(read('package.json')) as { version: string }
  assert.deepEqual(gate(`refs/tags/v${version}`), { code: 0, output: `Tag and package agree on ${version}.` })
})

test('a tag ahead of the package stops the build before it starts', () => {
  // The failure this closes: installers published announcing a version the tag does not name, so
  // the in-app check compares against a release it can never match.
  const refused = gate('refs/tags/v99.0.0')
  assert.equal(refused.code, 1)
  assert.match(refused.output, /99\.0\.0/)
})

test('anything that is not a release tag is refused', () => {
  // The message is asserted alongside the code: a gate that crashed before reading the ref would
  // also exit 1, and this test passed for exactly that reason while the script was broken.
  for (const ref of ['refs/heads/main', 'refs/tags/nightly', 'refs/tags/v1.2', '']) {
    const refused = gate(ref)
    assert.equal(refused.code, 1, ref)
    assert.match(refused.output, /is not a release tag/, ref)
  }
})

test('a prerelease tag is a release tag', () => {
  // `0.2.0-beta.1` is a version `src/shared/version.ts` ranks, so the chain must accept it.
  assert.match(gate('refs/tags/v0.2.0-beta.1').output, /0\.2\.0-beta\.1/)
})

/**
 * The site promises four file names. electron-builder has to build them under exactly those,
 * because `latest*.yml` — what the in-app update check reads — names the installer by its file
 * name and carries its checksum: renaming one afterwards points that metadata at nothing.
 */
test('the site serves the names the packages are built under', () => {
  const built = new Set([...read('electron-builder.yml').matchAll(/^\s*artifactName:\s*(\S+)/gm)].map(match => match[1]))
  const extensions = { dmg: 'mac', exe: 'windows', deb: 'deb', rpm: 'rpm' }
  const promised = new Set([...read('server/app.mjs').matchAll(/name:\s*'(Twichat-[^']+)'/g)].map(match => match[1]))
  assert.ok(built.size >= 3, `electron-builder names no artifact: ${[...built]}`)
  assert.ok(promised.size === 6, `the site promises ${promised.size} downloads, expected six`)
  for (const name of promised) {
    const extension = name.split('.').pop() as keyof typeof extensions
    assert.ok(extension in extensions, `${name} has an extension the release does not build`)
    // Comparing against the template only proves its shape. `${arch}` is filled with each
    // packager's own vocabulary rather than electron-builder's, so the names the release really
    // carries are spelled out here: a template that looked right shipped three names that did
    // not exist, and the site sent every Linux download to a file nobody had built.
    const template = name.replace(/\.[^.]+$/, '.${ext}').replace(/-(?:amd64|x86_64|arm64|aarch64)\./, '-${arch}.')
    assert.ok(built.has(template), `the site serves ${name} but nothing is built as ${template}`)
  }
  // The four Linux packages, by the names deb and rpm each give an architecture.
  for (const expected of ['Twichat-linux-amd64.deb', 'Twichat-linux-arm64.deb', 'Twichat-linux-x86_64.rpm', 'Twichat-linux-aarch64.rpm']) {
    assert.ok(promised.has(expected), `the release carries ${expected} and the site does not serve it`)
  }
})

/**
 * The font is redistributed twice: once as the package, once as a copy on the landing site. The
 * SIL OFL asks that the copyright notice and the licence travel with it, so the copy carries the
 * licence beside it — and a font upgrade that refreshes the copy without the licence, or the
 * reverse, is exactly the drift nobody notices.
 */
test('the font copy on the site is the packaged font, with its licence beside it', () => {
  const digest = (path: string) => createHash('sha256').update(readFileSync(join(root, path))).digest('hex')
  const copy = digest('server/public/assets/atkinson.woff2')
  const packaged = digest('node_modules/@fontsource-variable/atkinson-hyperlegible-next/files/atkinson-hyperlegible-next-latin-wght-normal.woff2')
  assert.equal(copy, packaged, 'the site serves a font that is not the one the package ships')
  const licence = read('server/public/assets/atkinson-OFL.txt')
  assert.match(licence, /SIL Open Font License, Version 1\.1/)
  assert.equal(licence, read('node_modules/@fontsource-variable/atkinson-hyperlegible-next/LICENSE'))
})

test('what the installer carries answers the licence and privacy questions on its own', () => {
  const packaged = read('electron-builder.yml')
  for (const file of ['LICENSE', 'NOTICE.md', 'PRIVACY.md']) assert.ok(packaged.includes(`'${file}'`), `${file} does not ship inside the installer`)
})

test('every host the application calls is listed in the privacy notice', () => {
  // A network call added without a line in that table makes the document a claim rather than a
  // list, which is the only thing that makes it worth anything.
  const listed = read('PRIVACY.md')
  const sources = ['src/main/twitch-data.ts', 'src/main/streams.ts', 'src/main/updates.ts', 'src/main/third-party-emotes.ts', 'src/main/twitch-emotes.ts', 'src/main/eventsub.ts', 'src/main/irc.ts']
  const called = new Set(sources.flatMap(file => [...read(file).matchAll(/\b(?:https|wss):\/\/([a-z0-9.-]+\.[a-z]{2,})/g)].map(match => match[1])))
  // Documentation links the application opens in a browser are not calls it makes.
  const browsed = new Set(['dev.twitch.tv', 'www.twitch.tv', 'github.com'])
  // Without this the test passes on a regex that stopped matching anything.
  assert.ok(called.size >= 8, `only found ${called.size} hosts: ${[...called]}`)
  for (const host of called) {
    if (browsed.has(host)) continue
    assert.ok(listed.includes(host), `${host} is called but not named in PRIVACY.md`)
  }
})

test('the release workflow refuses a missing installer rather than shipping without it', () => {
  const workflow = read('.github/workflows/build.yml')
  assert.ok(!workflow.includes('if-no-files-found: ignore'), 'an absent artifact would pass unnoticed')
  assert.ok(workflow.includes('release-gate.mjs'), 'the tag is never checked against the package')
  assert.ok(workflow.includes('fail_on_unmatched_files: true'), 'the release would publish an incomplete set')
})
