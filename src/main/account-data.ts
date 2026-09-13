import { fail, type ErrorKey } from '../shared/errors'
import type { BlockedUser, CategoryMatch, CategoryPage, ChannelSearch, FollowedChannels, StreamPage } from '../shared/types'

/** Both lists are cheap to redraw and expensive to fetch: a minute is the compromise. */
const TTL = 60_000
/** Enough queries to cover a hesitant search, few enough that the map cannot grow with the session. */
const SEARCH_CAP = 40
/**
 * The catalog used to be keyed by language alone — eight of them, a bounded map. A category is
 * keyed in beside it and there are thousands, so this map needs the same ceiling the searches
 * have: enough to walk back through a few browses without refetching, few enough to end.
 */
const CATALOG_CAP = 20

/** The blocked list is re-read rarely: it changes only when this application changes it. */
const BLOCKS_TTL = 10 * 60_000

export interface AccountSession {
  token: string | null; clientId: string | null; userId: string | null
  /** Whether the token carries `user:read:follows`, as the validation listed it. */
  follows: boolean
  /** Whether it carries the two blocked-users scopes, which Twitch grants together. */
  blocks: boolean
  generation: number
}

export interface AccountDataParts {
  /** Read afresh on every call: the generation it carries is what the answer is checked against. */
  session(): AccountSession
  streams(token: string, clientId: string, language: string, gameId: string, after: string): Promise<StreamPage>
  followed(userId: string, auth: { token: string; clientId: string }): Promise<FollowedChannels>
  search(query: string, auth: { token: string; clientId: string }): Promise<ChannelSearch>
  searchCategories(query: string, auth: { token: string; clientId: string }): Promise<CategoryMatch[]>
  topCategories(token: string, clientId: string, after: string): Promise<CategoryPage>
  /** Everyone the account has blocked on Twitch, every page of them. */
  blocked(userId: string, auth: { token: string; clientId: string }): Promise<BlockedUser[]>
  block(targetId: string, auth: { token: string; clientId: string }): Promise<void>
  unblock(targetId: string, auth: { token: string; clientId: string }): Promise<void>
  now?(): number
}

/**
 * The two lists that belong to an account rather than to a channel: what Twitch is streaming in
 * a language, and what the account follows.
 *
 * They live in a module of their own because of the wait in the middle. A list asked for by one
 * account can come back after another has signed in — the caches are emptied on that change, and
 * a late answer used to refill them with somebody else's channels, then hand them to the window
 * as if they were the new account's. The generation taken before the call is compared after it,
 * and an answer that no longer belongs is dropped rather than kept.
 */
export function createAccountData(parts: AccountDataParts) {
  const clock = parts.now ?? Date.now
  // Keyed by category and language together, because Twitch narrows on both.
  const catalogs = new Map<string, { expires: number; value: StreamPage }>()
  let followedList: { expires: number; value: FollowedChannels } | null = null
  // A query is typed letter by letter and each pause fires a call. Those calls repeat as soon as
  // a letter is taken back, so the answers are kept — capped, because a session's queries are not.
  const searches = new Map<string, { expires: number; value: ChannelSearch }>()
  // The categories matching those same queries, kept apart: the two searches are independent, and
  // one refused must not empty what the other found.
  const categorySearches = new Map<string, { expires: number; value: CategoryMatch[] }>()
  // Keyed by the cursor of the page before it, and emptied whole on a refresh for the same reason
  // the catalog is: the pages of a ranking only agree with each other while it holds still.
  const topCategoryPages = new Map<string, { expires: number; value: CategoryPage }>()
  let blockedList: { expires: number; value: BlockedUser[] } | null = null
  /**
   * The same list as a set of logins, because that is the question asked of it: every line coming
   * off the chat socket is checked against this one, and a chat line carries a login rather than
   * an id. Kept beside the list instead of derived on each read — a busy room asks a few hundred
   * times a second, and this answer must never be a promise.
   */
  let blockedLogins = new Set<string>()

  function authenticated(missing: ErrorKey) {
    const { token, clientId, userId, follows, blocks, generation } = parts.session()
    if (!token || !clientId) fail(missing)
    return { token, clientId, userId, follows, blocks, generation }
  }

  /** Reads the list and adopts it, under the generation it was asked for. */
  async function readBlocked(session: ReturnType<typeof authenticated>): Promise<BlockedUser[]> {
    const value = await parts.blocked(session.userId ?? '', { token: session.token, clientId: session.clientId })
    // The account can change while thirty pages come in. An answer belonging to the one before
    // must not become the set this one's messages are filtered against — which would either hide
    // the wrong people or, worse, stop hiding the right ones.
    if (parts.session().generation !== session.generation) fail('authCancelled')
    blockedList = { value, expires: clock() + BLOCKS_TTL }
    blockedLogins = new Set(value.map(user => user.login))
    return value
  }

  return {
    /** The catalog, in a language and — when one is named — in a single category. */
    async streams(language: string, refresh: boolean, gameId = '', after = ''): Promise<StreamPage> {
      const session = authenticated('needAccountForDiscover')
      // A refresh of the first page empties the whole map rather than its own entry: the pages
      // after it were cut from a ranking that has since moved, and serving them next to a fresh
      // first page is how a list gains duplicates and holes at once.
      if (refresh && !after) catalogs.clear()
      // Twitch narrows on all three, so all three are what an answer belongs to: a category held
      // under the language key alone would be served back as the whole catalog.
      const key = `${gameId}:${language}:${after}`
      // Read before any wait: serving from cache must not introduce one.
      const cached = catalogs.get(key)
      if (!refresh && cached && cached.expires > clock()) return cached.value
      const value = await parts.streams(session.token, session.clientId, language, gameId, after)
      if (parts.session().generation !== session.generation) fail('authCancelled')
      // A Map iterates in insertion order: dropping the head drops the browse left longest ago.
      if (!catalogs.has(key) && catalogs.size >= CATALOG_CAP) catalogs.delete(catalogs.keys().next().value!)
      catalogs.set(key, { value, expires: clock() + TTL })
      return value
    },

    async followed(refresh: boolean): Promise<FollowedChannels> {
      const session = authenticated('twitchFollowedReconnect')
      if (!refresh && followedList && followedList.expires > clock()) return followedList.value
      // A session opened before this view existed was granted chat and nothing else. Twitch turns
      // those two calls down with a 401 — the same status as a dead token — so the scope is read
      // where it is stated: asking anyway would cost a round trip to be told "session expired"
      // about a session that is very much alive. Below the cache on purpose: a renewal that came
      // back without the scope must not blank a list that is still good for another minute.
      if (!session.follows) fail('twitchFollowedScope')
      const value = await parts.followed(session.userId ?? '', { token: session.token, clientId: session.clientId })
      if (parts.session().generation !== session.generation) fail('authCancelled')
      followedList = { value, expires: clock() + TTL }
      return value
    },

    /** Searches Twitch by channel name, past the hundred streams the catalog holds. */
    async search(query: string): Promise<ChannelSearch> {
      const session = authenticated('needAccountForDiscover')
      const key = query.toLowerCase()
      const cached = searches.get(key)
      if (cached && cached.expires > clock()) return cached.value
      const value = await parts.search(query, { token: session.token, clientId: session.clientId })
      if (parts.session().generation !== session.generation) fail('authCancelled')
      // A Map iterates in insertion order: dropping the head drops the oldest query.
      if (searches.size >= SEARCH_CAP) searches.delete(searches.keys().next().value!)
      searches.set(key, { value, expires: clock() + TTL })
      return value
    },

    /** The same query, asked of Twitch's categories: the other half of a box that offers both. */
    async searchCategories(query: string): Promise<CategoryMatch[]> {
      const session = authenticated('needAccountForDiscover')
      const key = query.toLowerCase()
      const cached = categorySearches.get(key)
      if (cached && cached.expires > clock()) return cached.value
      const value = await parts.searchCategories(query, { token: session.token, clientId: session.clientId })
      if (parts.session().generation !== session.generation) fail('authCancelled')
      if (categorySearches.size >= SEARCH_CAP) categorySearches.delete(categorySearches.keys().next().value!)
      categorySearches.set(key, { value, expires: clock() + TTL })
      return value
    },

    /**
     * Whether this account has blocked someone, asked of every message that arrives.
     *
     * Twitch keeps sending a blocked person's chat down the socket — the block governs what they
     * may do to the account, not what the account is shown — so hiding them is this application's
     * work, and it can only be done with the list already in memory. Hence the eager load below
     * rather than a fetch on first read: a list that arrives after the messages do has let them
     * all through.
     */
    isBlocked(login: string) { return blockedLogins.has(login) },

    /** Everyone this account has blocked. */
    async blocked(refresh = false): Promise<BlockedUser[]> {
      const session = authenticated('blocksNoAccount')
      if (!refresh && blockedList && blockedList.expires > clock()) return blockedList.value
      // Below the cache, as the followed channels are: a token renewed without the scope must not
      // empty a list that is still good — and still the only thing hiding anybody.
      if (!session.blocks) fail('blocksScopeMissing')
      return readBlocked(session)
    },

    /**
     * Loads it on sign-in, and says nothing when it cannot. There is no one to tell at that
     * moment and nothing to do about it: the card says so when it is opened, and the next read
     * tries again.
     */
    preloadBlocked() {
      const { token, clientId, blocks } = parts.session()
      if (!token || !clientId || !blocks) return
      void Promise.resolve().then(() => readBlocked(authenticated('blocksNoAccount'))).catch(() => {})
    },

    /**
     * Blocks or unblocks someone on Twitch, then re-reads the list rather than patching it.
     * Twitch answers 204 whether anything changed or not, so its own answer is the only one worth
     * believing about what the list now holds.
     */
    async setBlocked(targetId: string, blocked: boolean): Promise<BlockedUser[]> {
      const session = authenticated('blocksNoAccount')
      if (!session.blocks) fail('blocksScopeMissing')
      const auth = { token: session.token, clientId: session.clientId }
      if (blocked) await parts.block(targetId, auth)
      else await parts.unblock(targetId, auth)
      if (parts.session().generation !== session.generation) fail('authCancelled')
      return readBlocked(session)
    },

    /** Twitch's categories by audience: the list the explorer opens on when nothing is typed. */
    async topCategories(refresh: boolean, after = ''): Promise<CategoryPage> {
      const session = authenticated('needAccountForDiscover')
      if (refresh && !after) topCategoryPages.clear()
      const cached = topCategoryPages.get(after)
      if (!refresh && cached && cached.expires > clock()) return cached.value
      const value = await parts.topCategories(session.token, session.clientId, after)
      if (parts.session().generation !== session.generation) fail('authCancelled')
      if (!topCategoryPages.has(after) && topCategoryPages.size >= CATALOG_CAP) topCategoryPages.delete(topCategoryPages.keys().next().value!)
      topCategoryPages.set(after, { value, expires: clock() + TTL })
      return value
    },

    /** Everything the outgoing account owned: emptied on sign-in, sign-out and window teardown. */
    clear() {
      catalogs.clear()
      followedList = null
      searches.clear()
      categorySearches.clear()
      topCategoryPages.clear()
      // The one cache here that decides what is shown rather than what is offered: left behind, it
      // would go on hiding the previous account's blocked people from this one's rooms.
      blockedList = null
      blockedLogins = new Set()
    }
  }
}
