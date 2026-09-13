const HEX = /^#[0-9a-f]{6}$/i

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/**
 * The colour Twitch writes a name in, out of `chat/color`.
 *
 * The endpoint answers a list because it takes up to a hundred ids at once; one is asked for
 * here, so the first entry is the answer. An empty string is a real answer and not a failure:
 * an account that has never picked one is written in a colour Twitch derives from its name, and
 * there is no way to ask which — the IRC `color` tag is empty for those accounts too.
 */
export function parseChatColor(payload: unknown): string {
  const values = Array.isArray(object(payload)?.data) ? object(payload)!.data as unknown[] : []
  const color = object(values[0])?.color
  return typeof color === 'string' && HEX.test(color) ? color.toLowerCase() : ''
}
