/**
 * The pages visited, so that "back" and "forward" mean something in a window that has no
 * address bar.
 *
 * The welcome page is deliberately absent. It is not a destination but the state before any
 * channel is open: its layout has no room for the video dock, and `updateDockPresence` hides
 * the player there. Coming back to it with a stream playing would leave sound without a
 * picture and without controls, so opening it clears the trail instead — which is also what it
 * means, since the only ways to reach it are signing in and closing the last channel.
 *
 * Channels are addressed by login rather than by position: two rooms are two pages, and the
 * order the sidebar happens to be in has nothing to do with the order they were opened in.
 */

/** A page the buttons can return to. `channel` is set for, and only for, a room. */
export interface Page { view: 'room' | 'discover' | 'settings'; channel?: string }

/**
 * Long enough that no session reaches it by hand, short enough that a window left open for a
 * week does not hold every room it ever showed.
 */
export const HISTORY_LIMIT = 50

const same = (a: Page, b: Page) => a.view === b.view && a.channel === b.channel

export class PageHistory {
  private pages: Page[] = []
  /** Where we stand in `pages`. `-1` is the empty trail, before anything was visited. */
  private index = -1

  current(): Page | undefined { return this.pages[this.index] }
  canBack(): boolean { return this.index > 0 }
  canForward(): boolean { return this.index < this.pages.length - 1 }

  /**
   * Records a page arrived at. Opening the page we are already on is not a move, and going
   * somewhere new drops whatever "forward" held — the branch we left is no longer reachable.
   */
  push(page: Page) {
    const current = this.current()
    if (current && same(current, page)) return
    this.pages.length = this.index + 1
    this.pages.push(page)
    if (this.pages.length > HISTORY_LIMIT) this.pages.splice(0, this.pages.length - HISTORY_LIMIT)
    this.index = this.pages.length - 1
  }

  back(): Page | undefined {
    if (!this.canBack()) return undefined
    this.index -= 1
    return this.current()
  }

  forward(): Page | undefined {
    if (!this.canForward()) return undefined
    this.index += 1
    return this.current()
  }

  /**
   * Drops the pages that no longer exist — a channel left is a page nothing can go back to.
   * The cursor follows the last surviving page at or before it, so the trail behind us stays
   * the trail behind us; with nothing left behind, only "forward" remains.
   */
  prune(isValid: (page: Page) => boolean) {
    const kept: Page[] = []
    let index = -1
    for (const [position, page] of this.pages.entries()) {
      if (!isValid(page)) continue
      kept.push(page)
      if (position <= this.index) index = kept.length - 1
    }
    this.pages = kept
    this.index = index
  }

  /** A new account, or the welcome page: nothing of the previous trail remains. */
  reset() { this.pages = []; this.index = -1 }
}
