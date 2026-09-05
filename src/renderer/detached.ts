import '@fontsource-variable/atkinson-hyperlegible-next'
import './style.css'
import type { BufferMode, DetachedContext } from '../shared/types'
import { StreamPlayer, type StreamPlayerState } from './player'
import { hydrateIcons, icon } from './icons'
import { hydrate } from './hydrate'
import { applyTheme } from './theme'
import { m, setLocale } from '../shared/i18n'

declare global { interface Window { twichat: import('../shared/types').TwichatAPI } }

/**
 * Video pulled out of the room. Detaching moves the picture, not the player: this window runs
 * the same controls as the dock, in the same order, and the room keeps driving it — entering a
 * channel, switching to the next one, opening the settings all reach it as they reached the dock.
 */
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!
const api = window.twichat
const video = $<HTMLVideoElement>('#detached-video')
const quality = $<HTMLSelectElement>('#detached-quality')
const muteButton = $<HTMLButtonElement>('#detached-mute')
const volumeSlider = $<HTMLInputElement>('#detached-volume')
const playButton = $<HTMLButtonElement>('#detached-play')
const stopButton = $<HTMLButtonElement>('#detached-stop')
const fullscreenButton = $<HTMLButtonElement>('#detached-fullscreen')
const pinButton = $<HTMLButtonElement>('#detached-pin')

let channel = ''
let buffer: BufferMode = 'balanced'
let state: StreamPlayerState = 'stopped'

const player = new StreamPlayer(video, api, (next, message) => {
  state = next
  paintState(message)
  void api.reportPlayerState(next, message)
})

const audioOnly = () => quality.value === 'audio_only'

function paintState(message?: string) {
  const status = $('#detached-status')
  status.className = `quiet-tag ${state}`
  status.textContent = state === 'playing' ? m.app.liveTag : state === 'loading' ? m.app.playerLoading
    : state === 'offline' ? m.app.playerOffline : state === 'reconnecting' ? m.app.playerReconnecting
      : state === 'error' ? m.app.playerError : m.app.playerStopped
  const interrupted = ['error', 'offline', 'reconnecting'].includes(state)
  const error = $('#detached-error')
  error.hidden = !interrupted
  error.textContent = message ?? ''
  $('#detached-placeholder').hidden = state === 'playing'
  $('#detached-title').textContent = state === 'loading' ? m.app.connectingToStream : state === 'offline' ? m.app.streamOver
    : state === 'reconnecting' ? m.app.streamComingBack : state === 'error' ? m.app.streamUnresponsive : m.app.keepAnEye
  $('#detached-detail').innerHTML = state === 'loading' ? m.app.askingTwitch : state === 'stopped' ? m.app.detachedIdle : ''
  playButton.disabled = state === 'loading' || state === 'reconnecting'
  playButton.title = state === 'error' || state === 'offline' ? m.app.retry : audioOnly() ? m.app.listen : m.app.play
  playButton.setAttribute('aria-label', playButton.title)
  stopButton.hidden = state === 'stopped'
  fullscreenButton.disabled = state !== 'playing'
  fullscreenButton.hidden = audioOnly()
}

/** The volume: set here, stored by the room, the only author of the account preferences. */
function paintVolume(report: boolean) {
  const silent = video.muted || video.volume === 0
  muteButton.setAttribute('aria-pressed', String(silent))
  muteButton.innerHTML = icon(silent ? 'close' : 'audio')
  muteButton.title = silent ? m.app.unmute : m.app.mute
  muteButton.setAttribute('aria-label', muteButton.title)
  volumeSlider.value = String(Math.round(video.volume * 100))
  volumeSlider.classList.toggle('silent', silent)
  if (report) void api.reportPlayerVolume(video.volume, video.muted)
}

function paintChannel() {
  $('#detached-channel').textContent = audioOnly() ? `AUDIO · # ${channel}` : `# ${channel}`
  document.title = `#${channel} — Twichat`
}

function play() {
  void player.play(channel, quality.value, buffer)
}

playButton.addEventListener('click', play)
stopButton.addEventListener('click', () => player.stop())
quality.addEventListener('change', () => {
  void api.reportPlayerQuality(quality.value)
  paintChannel()
  paintState()
  if (state !== 'stopped') play()
})
muteButton.addEventListener('click', () => {
  video.muted = !video.muted && video.volume > 0
  if (!video.muted && video.volume === 0) video.volume = 1
  paintVolume(true)
})
volumeSlider.addEventListener('input', () => {
  video.volume = Number(volumeSlider.value) / 100
  video.muted = video.volume === 0
  paintVolume(true)
})

function toggleFullscreen() {
  if (audioOnly()) return
  if (document.fullscreenElement) void document.exitFullscreen()
  else void video.requestFullscreen().catch(() => {})
}
fullscreenButton.addEventListener('click', toggleFullscreen)
// With no native controls, double-clicking stays the expected gesture to fill the screen.
$('#detached-stage').addEventListener('dblclick', toggleFullscreen)
document.addEventListener('fullscreenchange', () => {
  const full = document.fullscreenElement === video
  fullscreenButton.innerHTML = icon(full ? 'fullscreenExit' : 'fullscreen')
  fullscreenButton.title = full ? m.app.exitFullscreen : m.app.fullscreen
  fullscreenButton.setAttribute('aria-label', full ? m.app.exitFullscreen : m.app.enterFullscreen)
})
// Escape leaves fullscreen: Chromium hands the key to the document without acting on it.
window.addEventListener('keydown', event => {
  if (event.key === 'Escape' && document.fullscreenElement) void document.exitFullscreen()
})
/** Pinned, the window stays above the others — the reason one takes the video out in the first place. */
function paintPin(pinned: boolean) {
  pinButton.setAttribute('aria-pressed', String(pinned))
  pinButton.title = pinned ? m.app.unpinWindow : m.app.pinWindow
  pinButton.setAttribute('aria-label', pinButton.title)
}
pinButton.addEventListener('click', () => {
  const pinned = pinButton.getAttribute('aria-pressed') !== 'true'
  paintPin(pinned)
  void api.pinPlayer(pinned)
})
$('#detached-attach').addEventListener('click', () => { player.stop(); void api.attachPlayer() })

/**
 * The window takes the shape of the picture it is showing. The ratio comes from the stream
 * itself rather than an assumed 16/9, and the bar is measured rather than guessed: those two
 * numbers are what let the main process resize without ever leaving a black margin.
 */
function reportFrame() {
  const bar = document.querySelector('.detached-bar')
  const ratio = video.videoWidth > 0 && video.videoHeight > 0 ? video.videoWidth / video.videoHeight : 0
  void api.reportPlayerFrame(ratio, Math.round(bar?.getBoundingClientRect().height ?? 0))
}
video.addEventListener('loadedmetadata', reportFrame)
// Audio only carries no picture: the window goes back to resizing freely.
video.addEventListener('emptied', reportFrame)

/** The room keeps the hand: its rules arrive resolved, and this window applies them as the dock would. */
api.onPlayerCommand((action, room, nextQuality, nextBuffer) => {
  channel = room
  buffer = nextBuffer
  quality.value = nextQuality
  paintChannel()
  if (action === 'stop') { player.stop(); return }
  paintState()
  play()
})

async function start() {
  let context: DetachedContext
  try { context = await api.playerContext() }
  catch { return }
  setLocale(context.locale)
  applyTheme(context.theme)
  hydrate()
  hydrateIcons()
  channel = context.channel
  buffer = context.playback.buffer
  quality.value = context.quality
  video.volume = context.playback.volume
  video.muted = context.playback.muted
  paintVolume(false)
  paintPin(context.pinned)
  paintChannel()
  paintState()
  if (channel && context.play) play()
}
void start()
