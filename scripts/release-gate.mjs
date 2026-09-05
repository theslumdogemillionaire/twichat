#!/usr/bin/env node
/**
 * Refuses a release the tag and the package disagree about.
 *
 * `v0.2.0` builds whatever `package.json` says, and nothing checked that they matched: a tag
 * pushed a version ahead of the file published installers announcing themselves as the old one,
 * which the in-app update check then compares against and never offers. The README asked for the
 * two to be kept in step; this is what enforces it.
 *
 * Plain Node with no dependency on purpose: it runs before `npm ci`, so a mismatch costs seconds
 * rather than three packaging jobs.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The version a ref names, or null when the ref is not a release tag. */
export function tagVersion(ref) {
  const match = /^(?:refs\/tags\/)?v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(String(ref ?? '').trim())
  return match ? match[1] : null
}

export function gate(ref, version) {
  const tagged = tagVersion(ref)
  if (!tagged) return { ok: false, message: `"${ref}" is not a release tag: a release is built from a tag shaped v1.2.3.` }
  if (tagged !== version) return { ok: false, message: `The tag names ${tagged} and package.json says ${version}. Move one to the other before tagging.` }
  return { ok: true, message: `Tag and package agree on ${version}.` }
}

const [, script, ref] = process.argv
if (script && import.meta.url.endsWith(script.replace(/\\/g, '/').split('/').pop())) {
  // `.pathname` would do on a Unix path and nowhere else: on Windows a file URL keeps the drive
  // behind a slash, so `/D:/a/twichat/` reaches `join` and comes out as the unopenable
  // `\D:\a\twichat\package.json`. It also leaves every space percent-encoded.
  const root = fileURLToPath(new URL('..', import.meta.url))
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const result = gate(ref ?? process.env.GITHUB_REF, version)
  console.log(result.message)
  process.exit(result.ok ? 0 : 1)
}
