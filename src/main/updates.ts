import { app, shell } from 'electron'
// electron-updater is CommonJS and this bundle is ESM: a named import compiles and then fails
// at load. The default export is the module object, and the updater comes off it.
import updater from 'electron-updater'
import { isNewer } from '../shared/version'
import type { UpdateNotice } from '../shared/types'

const { autoUpdater } = updater

/**
 * Keeping the app current, as far as each system allows.
 *
 * Windows updates itself: the NSIS installer electron-updater drives needs no signature, so the
 * build is downloaded in the background and one restart applies it. macOS cannot: Squirrel.Mac
 * checks the code signature of what it downloads, and these builds carry none, so an install
 * would be refused rather than silently wrong. Linux is packaged as deb and rpm, which belong to
 * the system's package manager and are not electron-updater's to replace.
 *
 * Those two are told, not updated: the release is announced and the notice opens its page. That
 * is the honest version of "up to date" here, and it costs nothing to run.
 */
const REPO = 'theslumdogemillionaire/twichat'
const INTERVAL = 6 * 60 * 60 * 1000
/** A check is never worth waiting on: past this, the network is treated as away. */
const CHECK_TIMEOUT = 10_000
/** Long enough for the window to be up and the chat connected: the check is never the priority. */
const FIRST_CHECK = 30_000

const selfUpdates = process.platform === 'win32'
let pending: UpdateNotice | null = null

function releaseUrl(version: string) {
  return `https://github.com/${REPO}/releases/tag/v${version}`
}

/**
 * The latest release GitHub names, prereleases excluded. Any failure answers null: no notice.
 *
 * The call is given ten seconds. Without a deadline a connection that opens and then says nothing
 * — a captive portal, a network that went away mid-request — leaves this pending until the
 * process ends, and the check every six hours stacks another one behind it.
 */
async function latestRelease(): Promise<{ version: string; url: string } | null> {
  try {
    const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': `twichat/${app.getVersion()}` },
      signal: AbortSignal.timeout(CHECK_TIMEOUT)
    })
    if (!response.ok) return null
    const release = await response.json() as { tag_name?: unknown; html_url?: unknown }
    if (typeof release.tag_name !== 'string' || typeof release.html_url !== 'string') return null
    return { version: release.tag_name.replace(/^v/, ''), url: release.html_url }
  } catch (error) { return failed('reading the latest release', error) }
}

/**
 * An update check that did not work out. The user keeps the version they have and is told
 * nothing — a release they cannot reach is not their problem — but the reason goes to the log,
 * because "no update was ever offered" and "every check has been failing for a month" look
 * identical from the outside otherwise.
 */
function failed(what: string, error: unknown): null {
  console.warn(`Update check failed while ${what}:`, error instanceof Error ? error.message : 'unknown error')
  return null
}

/**
 * Starts watching. The notice is sent once per version: a check every six hours must not make
 * the same line reappear under someone who has already read it and chosen to keep working.
 */
export function watchUpdates(notify: (notice: UpdateNotice) => void): void {
  // In development the version is the one in package.json and there is nothing to update to.
  if (!app.isPackaged) return
  const announce = (notice: UpdateNotice) => {
    if (pending?.version === notice.version && pending.state === notice.state) return
    pending = notice
    notify(notice)
  }

  if (selfUpdates) {
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    // A failed check is not the user's problem: they keep the version they have. It is still
    // written down — an updater that has been failing since a release must be readable somewhere.
    autoUpdater.on('error', error => failed('downloading the update', error))
    autoUpdater.on('update-downloaded', info => announce({ state: 'ready', version: info.version, url: releaseUrl(info.version) }))
  }

  const check = async () => {
    if (selfUpdates) { await autoUpdater.checkForUpdates().catch(error => failed('asking for updates', error)); return }
    const release = await latestRelease()
    if (release && isNewer(release.version, app.getVersion())) announce({ state: 'available', ...release })
  }

  setTimeout(() => { void check(); setInterval(() => void check(), INTERVAL) }, FIRST_CHECK).unref()
}

/** What the notice does when clicked: restart onto the new build, or open its release page. */
export function applyUpdate(): void {
  if (!pending) return
  if (pending.state === 'ready') autoUpdater.quitAndInstall()
  else void shell.openExternal(pending.url)
}
