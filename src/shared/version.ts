/**
 * Version comparison, on the shape the releases are tagged with: three numbers and an
 * optional prerelease tag. It lives here rather than next to the updater so it can be
 * tested without Electron, and so the renderer could read it too.
 */
interface Version { numbers: [number, number, number]; pre: string[] }

function parse(value: string): Version | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value.trim())
  if (!match) return null
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split('.') : [],
  }
}

/** Numeric identifiers rank below alphanumeric ones, and compare as numbers between themselves. */
function comparePre(left: string[], right: string[]): number {
  // A version with no tag outranks the same numbers with one: 0.2.0 comes after 0.2.0-beta.1.
  if (!left.length || !right.length) return (left.length ? -1 : 0) + (right.length ? 1 : 0)
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const a = left[index], b = right[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    if (a === b) continue
    const numbers = /^\d+$/.test(a) && /^\d+$/.test(b)
    if (numbers) return Number(a) - Number(b)
    if (/^\d+$/.test(a)) return -1
    if (/^\d+$/.test(b)) return 1
    return a < b ? -1 : 1
  }
  return 0
}

/**
 * Whether `candidate` should replace `current`. Anything unparsable answers false: a malformed
 * tag on the release page must never push an update, and never hide one either.
 */
export function isNewer(candidate: string, current: string): boolean {
  const next = parse(candidate), now = parse(current)
  if (!next || !now) return false
  for (let index = 0; index < 3; index++) {
    if (next.numbers[index] !== now.numbers[index]) return next.numbers[index] > now.numbers[index]
  }
  return comparePre(next.pre, now.pre) > 0
}
