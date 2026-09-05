import { m, type Messages } from './i18n'
import { isWireError, type WireError } from './wire'

/** An error shown to the user is named by its key, never by its wording. */
export type ErrorKey = keyof Messages['errors']

/**
 * An action's error, carried by its catalog key rather than by its text.
 *
 * The key is what crosses the IPC and what the code decides on — the player's retry
 * policy, for instance. Translating a message must therefore never change a behavior.
 * `message` carries the key and not a sentence: a log reads better in a fixed language
 * than in the one a user happened to choose.
 */
export class AppError extends Error {
  constructor(readonly key: ErrorKey, readonly params: (string | number)[] = []) {
    // The message carries the key, and its params when there are any. It is the only channel
    // that survives `contextBridge`: from preload to renderer, an error keeps only `message`
    // and `stack`, never the fields one would have added to it.
    super(params.length ? `twichat:${key}:${JSON.stringify(params)}` : `twichat:${key}`)
    this.name = 'AppError'
  }
}

/** The key and its params read back out of the message, for an error that came from another bundle. */
function fromMessage(error: unknown): { key: ErrorKey, params: (string | number)[] } | null {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const match = /twichat:([A-Za-z]+)(?::(\[.*\]))?$/.exec(message)
  if (!match || !isErrorKey(match[1])) return null
  try { return { key: match[1], params: match[2] ? JSON.parse(match[2]) : [] } }
  catch { return { key: match[1], params: [] } }
}

/** A writing shorthand: `fail('channelInvalid')` reads better than a `throw new AppError(...)`. */
export function fail(key: ErrorKey, ...params: (string | number)[]): never {
  throw new AppError(key, params)
}

function text(key: ErrorKey, params: (string | number)[]): string {
  const entry = m.errors[key] as string | ((...args: (string | number)[]) => string)
  return typeof entry === 'function' ? entry(...params) : entry
}

/** A catalog key, as it arrives from elsewhere — from a server, for instance. */
export function isErrorKey(value: unknown): value is ErrorKey {
  return typeof value === 'string' && Object.hasOwn(m.errors, value)
}

/** The key of a known error, to decide a behavior without ever reading its wording. */
export function errorKey(error: unknown): ErrorKey | null {
  if (error instanceof AppError) return error.key
  if (isSerializedError(error)) return error.key
  return fromMessage(error)?.key ?? null
}

/** An error's text in the current language. What is not a known error comes out as is. */
export function errorText(error: unknown): string {
  if (error instanceof AppError) return text(error.key, error.params)
  if (isSerializedError(error)) return text(error.key, error.params)
  const recovered = fromMessage(error)
  if (recovered) return text(recovered.key, recovered.params)
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+': Error: /, '').replace(/^Error: /, '')
}

/** What the IPC carries: the shape lives in `wire.ts`, which the preload imports without the catalogs. */
export type SerializedError = WireError & { key: ErrorKey }

export function serializeError(error: unknown): SerializedError | null {
  return error instanceof AppError ? { __twichat: 'error', key: error.key, params: error.params } : null
}

export function isSerializedError(value: unknown): value is SerializedError {
  return isWireError(value)
}
