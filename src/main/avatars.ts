import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { channelName } from '../shared/validation'
import { fail } from '../shared/errors'

interface StoredAvatar { source: string; fetchedAt: number; data: string }
type AvatarData = Record<string, StoredAvatar>
type Fetch = (url: string) => Promise<Response>

// Twitch serves every profile picture from this host, the only one the renderer’s CSP allows.
const AVATAR_HOST = 'static-cdn.jtvnw.net'
const TYPES: Record<string, string> = { 'image/png': 'image/png', 'image/jpeg': 'image/jpeg', 'image/jpg': 'image/jpeg', 'image/gif': 'image/gif', 'image/webp': 'image/webp' }
const MAX_BYTES = 200 * 1024
const MAX_ENTRIES = 10
const FRESH_FOR = 24 * 60 * 60 * 1000

export function avatarSource(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) fail('avatarUrlInvalid')
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.hostname !== AVATAR_HOST || url.username || url.password || (url.port && url.port !== '443')) {
    fail('avatarHostForbidden')
  }
  return url.href
}

function validData(input: unknown): AvatarData {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  const result: AvatarData = {}
  for (const [key, item] of Object.entries(input as Record<string, unknown>).slice(0, MAX_ENTRIES)) {
    if (!item || typeof item !== 'object') continue
    const value = item as Record<string, unknown>
    try {
      const login = channelName(key)
      const source = avatarSource(value.source)
      if (typeof value.fetchedAt !== 'number' || !Number.isFinite(value.fetchedAt)) continue
      if (typeof value.data !== 'string' || !/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value.data)) continue
      if (value.data.length > 4 * MAX_BYTES) continue
      result[login] = { source, fetchedAt: value.fetchedAt, data: value.data }
    } catch { /* Ignore corrupted records: an avatar is only decoration. */ }
  }
  return result
}

export class AvatarStore {
  // The cache file is rewritten whole, so read, modify and write must stay together: queuing
  // the write alone let two avatars cached at once read the same state, and the second file
  // replaced the first.
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private readonly path: string, private readonly fetch: Fetch) {}

  /** Anything running inside here uses `read`/`persist`: the queue does not re-enter. */
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation)
    this.queue = next.then(() => {}, () => {})
    return next
  }

  private async read(): Promise<AvatarData> {
    try { return validData(JSON.parse(await readFile(this.path, 'utf8'))) }
    catch { return {} }
  }

  private async persist(data: AvatarData) {
    await mkdir(dirname(this.path), { recursive: true })
    await writeFile(`${this.path}.tmp`, JSON.stringify(data, null, 2), { mode: 0o600 })
    await rename(`${this.path}.tmp`, this.path)
  }

  private isFresh(data: AvatarData, login: string, source?: string) {
    const cached = data[login]
    if (!cached || cached.fetchedAt + FRESH_FOR <= Date.now()) return false
    return !source || cached.source === source
  }

  /** Every cached avatar as a data URL, keyed by login. */
  async all(): Promise<Record<string, string>> {
    return this.serialize(async () => Object.fromEntries(Object.entries(await this.read()).map(([login, avatar]) => [login, avatar.data])))
  }

  async fresh(input: unknown, source?: string) {
    const login = channelName(input)
    return this.serialize(async () => this.isFresh(await this.read(), login, source))
  }

  async remember(input: unknown, sourceInput: unknown) {
    const login = channelName(input)
    const source = avatarSource(sourceInput)
    if (await this.fresh(login, source)) return
    // The download stays outside the queue: a slow CDN must not hold the file against
    // another account being cached behind it.
    const response = await this.fetch(source)
    if (!response.ok) fail('avatarUnavailable')
    const declared = Number(response.headers.get('Content-Length') ?? 0)
    if (declared > MAX_BYTES) fail('avatarTooLarge')
    const type = TYPES[(response.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase()]
    if (!type) fail('avatarFormatUnsupported')
    const body = Buffer.from(await response.arrayBuffer())
    if (!body.length || body.length > MAX_BYTES) fail('avatarTooLarge')
    return this.serialize(async () => {
      const data = await this.read()
      // Keep the freshest avatars only, so app:init never ships an unbounded payload.
      const kept = Object.entries(data).filter(([key]) => key !== login).sort((a, b) => b[1].fetchedAt - a[1].fetchedAt).slice(0, MAX_ENTRIES - 1)
      await this.persist({ [login]: { source, fetchedAt: Date.now(), data: `data:${type};base64,${body.toString('base64')}` }, ...Object.fromEntries(kept) })
    })
  }

  async forget(input: unknown) {
    const login = channelName(input)
    return this.serialize(async () => {
      const data = await this.read()
      if (!(login in data)) return
      delete data[login]
      await this.persist(data)
    })
  }
}
