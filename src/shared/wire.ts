/**
 * The shape of an error that crosses the IPC.
 *
 * This module depends on nothing: the preload imports it without carrying the catalogs, and the
 * marker stays **structural**. An `instanceof` would not do — preload, renderer and
 * main process are three distinct bundles, each with its own copy of the classes.
 */
export interface WireError { __twichat: 'error'; key: string; params: (string | number)[] }

export function isWireError(value: unknown): value is WireError {
  return !!value && typeof value === 'object' && (value as WireError).__twichat === 'error'
}

/**
 * Turns the envelope back into an `Error` on the side that receives it. The fields are copied
 * onto the object, which lets `isWireError` recognize it as readily as an original error.
 */
export function wireErrorToError(wire: WireError): Error {
  // The params ride in the message: past the context bridge, that is all that is left.
  const error = new Error(wire.params.length ? `twichat:${wire.key}:${JSON.stringify(wire.params)}` : `twichat:${wire.key}`)
  error.name = 'AppError'
  return Object.assign(error, { __twichat: 'error' as const, key: wire.key, params: wire.params })
}
