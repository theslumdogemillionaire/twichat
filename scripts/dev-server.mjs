/**
 * Development supervisor for the site container.
 *
 * `node --watch` listens for filesystem events, and those do not cross the bind
 * mount from macOS into the Linux VM: the watcher is installed but never fires,
 * so an edit on the host changes nothing until the container is rebuilt. This
 * polls modification times instead: a second of latency, but it actually
 * notices, whatever the mount is made of.
 *
 * Only used by docker-compose; production runs `server/index.mjs` directly.
 */
import { spawn } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

const ROOT = 'server'
const ENTRY = join(ROOT, 'index.mjs')
const INTERVAL = 1000

/** Newest modification time and file count: the count catches additions and deletions,
    which a maximum alone would miss. */
async function fingerprint(directory) {
  let latest = 0
  let files = 0
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      const nested = await fingerprint(path)
      latest = Math.max(latest, nested.latest)
      files += nested.files
    } else {
      latest = Math.max(latest, (await stat(path)).mtimeMs)
      files += 1
    }
  }
  return { latest, files }
}

let child = null

function start() {
  child = spawn(process.execPath, [ENTRY], { stdio: 'inherit' })
}

/** The port is only free once the previous process is gone: wait for its exit
    rather than racing it. */
function restart() {
  if (!child) return start()
  const previous = child
  child = null
  previous.once('exit', start)
  previous.kill('SIGTERM')
}

start()
let previous = await fingerprint(ROOT)

setInterval(async () => {
  const current = await fingerprint(ROOT).catch(() => previous)
  if (current.latest === previous.latest && current.files === previous.files) return
  previous = current
  console.log('[dev] change detected, restarting')
  restart()
}, INTERVAL)

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child?.kill(signal)
    process.exit(0)
  })
}
