const paths: Record<string, string> = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  hash: '<path d="m10 3-4 18M18 3l-4 18M4 8h17M2 16h17"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  // The way back, mirroring `arrow`: the two sit side by side in the title bar.
  arrowBack: '<path d="M19 12H5m6-6-6 6 6 6"/>',
  down: '<path d="M12 5v14m-6-6 6 6 6-6"/>',
  // The chevron points up: menus at the bottom of the sidebar open above their button.
  chevron: '<path d="m7 14 5-5 5 5"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14-5L3 9m0-6v6h6m-5 4a8 8 0 0 0 14 5l3-3m0 6v-6h-6"/>',
  user: '<circle cx="12" cy="8" r="3"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/>',
  video: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m10 9 5 3-5 3Z"/>',
  audio: '<path d="M11 5 6 9H3v6h3l5 4Z"/><path d="M15 9a4 4 0 0 1 0 6M18 6a8 8 0 0 1 0 12"/>',
  play: '<path d="m8 5 11 7-11 7Z"/>',
  chat: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z"/><path d="M8 10h8M8 14h5"/>',
  bolt: '<path d="m13 2-9 12h7l-1 8 10-13h-7Z"/>',
  external: '<path d="M15 3h6v6m0-6L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>',
  leave: '<path d="M9 5H4v14h5m5-14 7 7-7 7m-6-7h13"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  reply: '<path d="M9 5 3 11l6 6"/><path d="M3 11h9a8 8 0 0 1 8 8v1"/>',
  // Filled, like every stop button: an outline reads as a frame, not as a control.
  stop: '<rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor"/>',
  // The pair for the detached video: the picture leaves its frame, then comes back into it.
  detach: '<path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/><path d="M14 4h6v6"/><path d="m20 4-8 8"/>',
  pin: '<path d="M12 17v5"/><path d="M9.5 3h5l-.8 5.6 2.8 2.6V13H7.5v-1.8l2.8-2.6z"/>',
  attach: '<path d="M14 20h4a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v4"/><path d="M10 20H4v-6"/><path d="m4 20 8-8"/>',
  fullscreen: '<path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/>',
  fullscreenExit: '<path d="M3 8h5V3M21 8h-5V3M3 16h5v5M21 16h-5v5"/>',
  corner: '<path d="M4 4h16v16H4Z"/><path d="M12 12h8v8h-8Z"/>',
  explore: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5Z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  people: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 1 0 7.8"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  smile: '<circle cx="12" cy="12" r="9"/><path d="M8.4 14.2a4.6 4.6 0 0 0 7.2 0"/><path d="M9 9.4h.01M15 9.4h.01"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  heart: '<path d="M12 20s-7-4.4-9-8.5A5 5 0 0 1 12 6a5 5 0 0 1 9 5.5C19 15.6 12 20 12 20Z"/>',
  // The same heart, filled: a channel the account already follows.
  heartFull: '<path fill="currentColor" d="M12 20s-7-4.4-9-8.5A5 5 0 0 1 12 6a5 5 0 0 1 9 5.5C19 15.6 12 20 12 20Z"/>',
  verified: '<path d="M12 3l7 3v5.5c0 4.3-2.9 7.7-7 9-4.1-1.3-7-4.7-7-9V6Z"/><path d="m9 12 2 2 4-4"/>',
  exit: '<path d="M13 4H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h6"/><path d="M10 12h11m-4.5-4.5L21 12l-4.5 4.5"/>',
  check: '<path d="m5 13 4 4 10-10"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z"/>'
}
export function icon(name: string) { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.hash}</svg>` }
export function hydrateIcons(root: ParentNode = document) { root.querySelectorAll<HTMLElement>('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon!) }) }
