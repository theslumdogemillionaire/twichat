/**
 * Joining the pages of a Twitch listing.
 *
 * Twitch pages a ranking, not a snapshot: between the call for one page and the call for the next
 * the rows reorder, and one that slipped down comes back. Appending blindly cards it twice. The
 * first sighting wins, so a card the reader has already scrolled past does not move under them.
 *
 * A page that adds nothing is what the end of a shifting list looks like, and it is answered with
 * the very list that came in — the caller reads that from the identity rather than from a flag.
 */
export function mergeById<T>(existing: T[], incoming: T[], key: (item: T) => string): T[] {
  const known = new Set(existing.map(key))
  const added = incoming.filter(item => {
    const id = key(item)
    if (known.has(id)) return false
    known.add(id)
    return true
  })
  return added.length ? [...existing, ...added] : existing
}
