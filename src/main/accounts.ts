import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { channelName } from '../shared/validation'
import { fail } from '../shared/errors'

interface StoredAccount { login: string; secret: string }
interface AccountData { accounts: StoredAccount[]; autoLogin: string | null }
export interface AccountCredentials { accessToken: string; refreshToken?: string }
type Encrypt = (plainText: string) => Promise<string>
type Decrypt = (encrypted: string) => Promise<string>

function validAccounts(input: unknown): StoredAccount[] {
  if (!Array.isArray(input)) return []
  const result: StoredAccount[] = []
  for (const item of input.slice(0, 10)) {
    if (!item || typeof item !== 'object') continue
    const value = item as Record<string, unknown>
    try {
      const login = channelName(value.login)
      if (typeof value.secret !== 'string' || !/^[a-zA-Z0-9+/=]{8,8192}$/.test(value.secret)) continue
      if (!result.some(account => account.login === login)) result.push({ login, secret: value.secret })
    } catch { /* Ignore corrupted records without exposing encrypted contents. */ }
  }
  return result
}

function validData(input: unknown): AccountData {
  if (Array.isArray(input)) return { accounts: validAccounts(input), autoLogin: null }
  if (!input || typeof input !== 'object') return { accounts: [], autoLogin: null }
  const value = input as Record<string, unknown>
  const accounts = validAccounts(value.accounts)
  let autoLogin: string | null = null
  try {
    const candidate = value.autoLogin === null ? null : channelName(value.autoLogin)
    if (candidate && accounts.some(account => account.login === candidate)) autoLogin = candidate
  } catch { /* Invalid preference falls back to the chooser. */ }
  return { accounts, autoLogin }
}

export class AccountStore {
  // Read, modify, write inside one queue, the way `PreferencesStore.patch` does. Queuing the
  // write alone was not enough: two sign-ins landing together both read the state before either
  // wrote, and the second file replaced the first — one of the two accounts was simply lost.
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private readonly path: string, private readonly encrypt: Encrypt, private readonly decrypt: Decrypt) {}

  /**
   * Runs an operation with the file to itself. Whatever it reads is what it writes.
   * Anything inside it must use `read`/`persist`, never a public method: the queue does not
   * re-enter, and an operation waiting for itself would never end.
   */
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation)
    this.queue = next.then(() => {}, () => {})
    return next
  }

  private async read(): Promise<AccountData> {
    try { return validData(JSON.parse(await readFile(this.path, 'utf8'))) }
    catch { return { accounts: [], autoLogin: null } }
  }

  private async persist(data: AccountData) {
    await mkdir(dirname(this.path), { recursive: true })
    await writeFile(`${this.path}.tmp`, JSON.stringify(data, null, 2), { mode: 0o600 })
    await rename(`${this.path}.tmp`, this.path)
  }

  async list() { return this.serialize(async () => (await this.read()).accounts.map(account => account.login)) }
  async preferred() { return this.serialize(async () => (await this.read()).autoLogin) }

  async credentials(input: unknown): Promise<AccountCredentials> {
    const login = channelName(input)
    // The record is read under the queue; deciphering it happens outside, so a keychain call
    // never holds the file against a sign-in waiting behind it.
    const account = await this.serialize(async () => (await this.read()).accounts.find(item => item.login === login))
    if (!account) fail('accountForgotten')
    const plain = await this.decrypt(account.secret)
    try {
      const parsed = JSON.parse(plain) as Record<string, unknown>
      if (typeof parsed.accessToken === 'string' && parsed.accessToken.length > 0 && parsed.accessToken.length <= 4096) {
        const refreshToken = typeof parsed.refreshToken === 'string' && parsed.refreshToken.length <= 4096 ? parsed.refreshToken : undefined
        return refreshToken ? { accessToken: parsed.accessToken, refreshToken } : { accessToken: parsed.accessToken }
      }
    } catch { /* Records from the first alpha stored the access token directly. */ }
    if (!plain || plain.length > 4096) fail('accountCorrupted')
    return { accessToken: plain }
  }

  async token(input: unknown) { return (await this.credentials(input)).accessToken }

  async save(input: unknown, accessToken: string, refreshToken?: string) {
    const login = channelName(input)
    if (!accessToken || accessToken.length > 4096 || (refreshToken && refreshToken.length > 4096)) fail('accountSessionInvalid')
    // Enciphering happens inside the queue too, so the calls apply in the order they were made:
    // a sign-in issued before a pause must not land after it and revive the auto-login.
    return this.serialize(async () => {
      const secret = await this.encrypt(JSON.stringify({ accessToken, ...(refreshToken ? { refreshToken } : {}) }))
      const data = await this.read()
      data.accounts = [{ login, secret }, ...data.accounts.filter(account => account.login !== login)].slice(0, 10)
      data.autoLogin = login
      await this.persist(data)
    })
  }

  async select(input: unknown) {
    const login = channelName(input)
    return this.serialize(async () => {
      const data = await this.read()
      const account = data.accounts.find(item => item.login === login)
      if (!account) fail('accountForgotten')
      data.accounts = [account, ...data.accounts.filter(item => item.login !== login)]
      data.autoLogin = login
      await this.persist(data)
    })
  }

  async pauseAutoLogin() {
    return this.serialize(async () => {
      const data = await this.read()
      data.autoLogin = null
      await this.persist(data)
    })
  }

  async remove(input: unknown) {
    const login = channelName(input)
    return this.serialize(async () => {
      const data = await this.read()
      data.accounts = data.accounts.filter(account => account.login !== login)
      if (data.autoLogin === login) data.autoLogin = null
      await this.persist(data)
    })
  }

  /** Waits for the queued operations to finish: closing must not cut the last write short. */
  settled(): Promise<void> { return this.queue.then(() => {}, () => {}) }
}
