/**
 * Names the development bundle, so the macOS menu bar reads `twichat.` and not `Electron`.
 *
 * On macOS the application menu takes its title from the `CFBundleName` of the bundle that is
 * running, read once at launch: `app.setName()` and the label of the first menu template entry
 * are both ignored there. In development the bundle is Electron's own, under `node_modules`,
 * so the name has to be written into its `Info.plist`.
 *
 * The packaged app is left alone: it already reads `Twichat`, from `productName`, and that name
 * cannot be overridden on its own. Electron looks up its helper processes through `CFBundleName`
 * too, and electron-builder names the helper bundles after `productName`; a bundle name that
 * drifts from them dies on launch with `Unable to find helper app`. Electron's own bundle keeps
 * its stock helpers, which the fallback lookup still finds, so only development can be renamed.
 *
 * Runs from `postinstall`, because reinstalling Electron brings back the stock plist.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, utimesSync } from 'node:fs'

const NAME = 'twichat.'
const BUNDLE = 'node_modules/electron/dist/Electron.app'
const PLIST = `${BUNDLE}/Contents/Info.plist`

// Nothing else reads these keys, and an install that skipped Electron leaves no bundle behind.
if (process.platform !== 'darwin' || !existsSync(PLIST)) process.exit(0)

try {
  for (const key of ['CFBundleName', 'CFBundleDisplayName']) execFileSync('plutil', ['-replace', key, '-string', NAME, PLIST])
  // The Dock and the Finder hold on to the previous name until the bundle's own date moves.
  const now = new Date()
  utimesSync(BUNDLE, now, now)
} catch (error) {
  // A cosmetic name is no reason to fail an install.
  console.warn(`dev-app-name: left the bundle named Electron (${error.message})`)
}
