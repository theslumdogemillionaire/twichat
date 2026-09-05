import type { ChatMessage } from '../shared/types'

export const FOLLOW_THRESHOLD = 60
const AT_BOTTOM = 2
/** A deliberate scroll up releases the log straight away; only coming back down re-follows. */
export function pinnedAfterScroll(previous: boolean, distanceFromBottom: number, userInitiated: boolean, scrolledUp = false) {
  if (!userInitiated) return previous || distanceFromBottom < FOLLOW_THRESHOLD
  if (scrolledUp) return distanceFromBottom < AT_BOTTOM
  return distanceFromBottom < FOLLOW_THRESHOLD
}

/** Variable-height windowing. Only viewport + 300px overscan exists in the DOM. */
export class VirtualLog {
  private items: ChatMessage[] = []
  private heights = new Map<string, number>()
  private rows = new Map<string, HTMLElement>()
  private offsets = new Map<string, number>()
  private lastScrollTop = 0
  private frame = 0
  private pinned = true
  private observer: ResizeObserver
  private viewportObserver: ResizeObserver
  private width = 0
  private pointerScrolling = false
  private userScrollUntil = 0
  private visible = false
  constructor(private viewport: HTMLElement, private space: HTMLElement, private create: (message: ChatMessage) => HTMLElement, private onPinned: (pinned: boolean) => void) {
    this.observer = new ResizeObserver(entries => {
      let changed = false
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.id!
        const height = Math.ceil(entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height)
        if (height && this.heights.get(id) !== height) { this.heights.set(id, height); changed = true }
      }
      if (changed) this.schedule()
    })
    this.viewportObserver = new ResizeObserver(() => {
      if (!this.visible) return
      if (this.width !== viewport.clientWidth) { this.width = viewport.clientWidth; this.heights.clear() }
      this.schedule()
    })
    this.viewportObserver.observe(viewport)
    const markUserScroll = () => { this.userScrollUntil = performance.now() + 500 }
    viewport.addEventListener('wheel', markUserScroll, { passive: true })
    viewport.addEventListener('touchstart', () => { this.pointerScrolling = true }, { passive: true })
    viewport.addEventListener('touchend', () => { this.pointerScrolling = false; markUserScroll() }, { passive: true })
    viewport.addEventListener('pointerdown', () => { this.pointerScrolling = true }, { passive: true })
    window.addEventListener('pointerup', () => { if (this.pointerScrolling) { this.pointerScrolling = false; markUserScroll() } }, { passive: true })
    viewport.addEventListener('keydown', event => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) markUserScroll()
    })
    viewport.addEventListener('scroll', () => {
      const distance = Math.max(0, viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight)
      const scrolledUp = viewport.scrollTop < this.lastScrollTop
      this.lastScrollTop = viewport.scrollTop
      const userInitiated = this.pointerScrolling || performance.now() < this.userScrollUntil
      this.pinned = pinnedAfterScroll(this.pinned, distance, userInitiated, scrolledUp)
      this.onPinned(this.pinned)
      this.schedule()
    }, { passive: true })
  }
  setVisible(visible: boolean) {
    if (this.visible === visible) return
    this.visible = visible
    if (!visible) {
      if (this.frame) cancelAnimationFrame(this.frame)
      this.frame = 0
      return
    }
    if (this.width !== this.viewport.clientWidth) { this.width = this.viewport.clientWidth; this.heights.clear() }
    this.render()
  }
  set(items: ChatMessage[], reset = false) {
    // Preserve the top visible message when bounded history evicts older entries.
    let anchor: { id: string; offset: number } | undefined
    if (!this.pinned && !reset) {
      let top = 0
      for (const message of this.items) {
        const height = this.heights.get(message.id) ?? 64
        if (top + height > this.viewport.scrollTop) { anchor = { id: message.id, offset: this.viewport.scrollTop - top }; break }
        top += height
      }
    }
    this.items = [...items]
    const ids = new Set(items.map(item => item.id))
    for (const id of this.heights.keys()) if (!ids.has(id)) this.heights.delete(id)
    if (reset) { this.pinned = true; this.pointerScrolling = false; this.userScrollUntil = 0; this.onPinned(true) }
    this.render()
    if (anchor) {
      let top = 0
      for (const message of this.items) {
        if (message.id === anchor.id) { this.moveTo(top + anchor.offset); break }
        top += this.heights.get(message.id) ?? 64
      }
      this.schedule()
    }
  }
  bottom() { this.pinned = true; this.onPinned(true); this.render() }
  /** Brings a quoted message on screen; false once it has left the history. */
  scrollTo(id: string) {
    let top = 0
    for (const message of this.items) {
      if (message.id === id) {
        this.pinned = false
        this.onPinned(false)
        const height = this.heights.get(id) ?? 64
        this.moveTo(Math.max(0, top - Math.max(0, (this.viewport.clientHeight - height) / 2)))
        this.render()
        return true
      }
      top += this.heights.get(message.id) ?? 64
    }
    return false
  }
  refresh() {
    for (const row of this.rows.values()) { this.observer.unobserve(row); row.remove() }
    this.rows.clear()
    this.render()
  }
  /** Each move of our own becomes the new reference, so it never reads back as a user scroll. */
  private moveTo(top: number) { this.viewport.scrollTop = top; this.lastScrollTop = this.viewport.scrollTop }
  /** The row sitting under the top edge, taken from the layout currently on screen. */
  private anchor() {
    let found: { id: string; top: number } | undefined
    for (const message of this.items) {
      const top = this.offsets.get(message.id)
      if (top === undefined) continue
      if (top > this.viewport.scrollTop) break
      found = { id: message.id, top }
    }
    return found
  }
  private schedule() { if (this.visible && !this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.render() }) }
  private render() {
    if (!this.visible) return
    const anchor = this.pinned ? undefined : this.anchor()
    const positions: number[] = []
    const offsets = new Map<string, number>()
    let total = 0
    for (const message of this.items) { positions.push(total); offsets.set(message.id, total); total += this.heights.get(message.id) ?? 64 }
    this.space.style.height = `${total}px`
    this.offsets = offsets
    if (this.pinned) this.moveTo(this.viewport.scrollHeight)
    else if (anchor) {
      // Measuring a row corrects its height; move with it so the reader's place holds still.
      const moved = offsets.get(anchor.id)
      if (moved !== undefined && moved !== anchor.top) this.moveTo(Math.max(0, this.viewport.scrollTop + moved - anchor.top))
    }
    const top = this.viewport.scrollTop - 300
    const bottom = this.viewport.scrollTop + this.viewport.clientHeight + 300
    const visible = new Set<string>()
    this.items.forEach((message, index) => {
      if (positions[index] + (this.heights.get(message.id) ?? 64) < top || positions[index] > bottom) return
      visible.add(message.id)
      let row = this.rows.get(message.id)
      if (!row) {
        row = this.create(message); row.dataset.id = message.id
        this.rows.set(message.id, row); this.space.append(row); this.observer.observe(row)
      }
      row.style.transform = `translateY(${positions[index]}px)`
    })
    for (const [id, row] of this.rows) if (!visible.has(id)) { this.observer.unobserve(row); row.remove(); this.rows.delete(id) }
  }
}
