import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// The content hash changes when a resource changes, including a CSS dependency.
// Only matching hashes receive immutable caching; legacy unversioned URLs remain short-lived.
export function buildAssetManifest(root) {
  const assets = new Map()
  function scan(directory, prefix = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'downloads') continue
      const path = `${prefix}/${entry.name}`
      if (entry.isDirectory()) scan(join(directory, entry.name), path)
      else if (/\.(png|webp|svg|woff2|css|js)$/.test(path)) {
        const body = readFileSync(join(directory, entry.name))
        assets.set(path, { hash: createHash('sha256').update(body).digest('hex').slice(0, 16) })
      }
    }
  }
  scan(root)
  for (const [path, asset] of assets) {
    if (!path.endsWith('.css')) continue
    asset.body = versionAssets(readFileSync(join(root, path.slice(1)), 'utf8'), assets)
    asset.hash = createHash('sha256').update(asset.body).digest('hex').slice(0, 16)
  }
  return assets
}

export function versionAssets(html, assets) {
  return html.replace(/\/(?:assets\/[\w./-]+|[\w-]+\.(?:css|js))(?:\?v=[\w.-]+)?/g, match => {
    const path = match.split('?')[0]
    const asset = assets.get(path)
    return asset ? `${path}?v=${asset.hash}` : match
  })
}
