import type Hls from 'hls.js'
import type { BufferMode, TwichatAPI } from '../shared/types'
import { bufferProfile, STREAM_STALL_TIMEOUT, streamRetryPlan, type StreamPlayerState } from './stream-lifecycle'
import { AppError, errorText, fail } from '../shared/errors'
import { m } from '../shared/i18n'

export type { StreamPlayerState } from './stream-lifecycle'

/** The buffering mode travels with the desired stream: a retry reuses the setting as it was then, not the DOM's. */
interface DesiredStream { channel: string; quality: string; buffer: BufferMode }

export class StreamPlayer {
  private hls?: Hls
  private desired?: DesiredStream
  private generation = 0
  private mediaRecoveries = 0
  private retryAttempt = 0
  private retryTimer?: ReturnType<typeof setTimeout>
  private lastMediaTime = 0
  private lastProgressAt = 0
  private remoteStop: Promise<void> = Promise.resolve()

  constructor(private video: HTMLVideoElement, private api: TwichatAPI, private status: (state: StreamPlayerState, message?: string) => void) {
    video.addEventListener('timeupdate', () => this.noteProgress())
    video.addEventListener('playing', () => this.noteProgress())
    video.addEventListener('ended', () => this.failCurrent(new AppError('streamEnded')))
    video.addEventListener('error', () => { if (this.hls) this.failCurrent(new AppError('mediaUnresponsive')) })
    setInterval(() => this.checkHealth(), 5_000)
  }

  async play(channel: string, quality: string, buffer: BufferMode = 'balanced') {
    this.desired = { channel, quality, buffer }
    this.retryAttempt = 0
    clearTimeout(this.retryTimer)
    await this.attempt(true)
  }

  stop() {
    this.desired = undefined
    clearTimeout(this.retryTimer)
    this.generation++
    this.destroyLocal()
    this.queueRemoteStop()
    this.status('stopped')
  }

  private async attempt(initial: boolean) {
    const desired = this.desired
    if (!desired) return
    this.destroyLocal()
    const generation = ++this.generation
    this.status(initial ? 'loading' : 'reconnecting', initial ? undefined : m.player.searching)
    try {
      // Prevent an older asynchronous stop from cancelling this new resolver.
      await this.remoteStop.catch(() => {})
      if (generation !== this.generation || this.desired !== desired) return
      const [url, module] = await Promise.all([this.api.resolveStream(desired.channel, desired.quality), import('hls.js')])
      if (generation !== this.generation || this.desired !== desired) return
      const HlsClass = module.default
      if (!HlsClass.isSupported()) fail('hlsUnsupported')
      // The durations come from the buffering mode chosen in the settings; see BUFFER_PROFILES.
      // lowLatencyMode stays required in every mode: it is what enables the catch-up
      // through maxLiveSyncPlaybackRate when the delay exceeds liveMaxLatencyDuration.
      const hls = new HlsClass({
        enableWorker: true, lowLatencyMode: true, maxLiveSyncPlaybackRate: 1.5,
        ...bufferProfile(desired.buffer)
      })
      this.hls = hls
      this.mediaRecoveries = 0
      this.lastProgressAt = Date.now()
      this.lastMediaTime = this.video.currentTime
      hls.on(HlsClass.Events.ERROR, (_event, data) => {
        if (generation !== this.generation || !data.fatal) return
        if (data.type === HlsClass.ErrorTypes.MEDIA_ERROR && this.mediaRecoveries++ < 1) hls.recoverMediaError()
        else this.failCurrent(new AppError('streamInterrupted'), generation)
      })
      hls.on(HlsClass.Events.MANIFEST_PARSED, () => {
        if (generation !== this.generation) return
        this.video.hidden = false
        this.video.play().then(() => {
          if (generation !== this.generation) return
          this.retryAttempt = 0
          this.noteProgress()
          this.status('playing')
        }).catch(() => {
          if (generation === this.generation) this.status('error', m.player.pressPlay)
        })
      })
      hls.attachMedia(this.video)
      hls.loadSource(url)
    } catch (error) {
      if (generation === this.generation) this.failCurrent(error instanceof Error ? error : new AppError('streamUnavailable'), generation)
    }
  }

  private failCurrent(reason: unknown, expectedGeneration = this.generation) {
    if (!this.desired || expectedGeneration !== this.generation) return
    const plan = streamRetryPlan(reason, this.retryAttempt++)
    this.generation++
    this.destroyLocal()
    this.queueRemoteStop()
    clearTimeout(this.retryTimer)
    if (!plan.retry) { this.status('error', errorText(reason)); return }
    const seconds = Math.round(plan.delay / 1000)
    this.status(plan.state, plan.state === 'offline' ? m.player.offlineRetry(seconds) : m.player.interruptedRetry(seconds))
    this.retryTimer = setTimeout(() => { if (this.desired) void this.attempt(false) }, plan.delay)
  }

  private noteProgress() {
    const current = this.video.currentTime
    if (current > this.lastMediaTime + .05) { this.lastMediaTime = current; this.lastProgressAt = Date.now() }
  }

  private checkHealth() {
    if (!this.desired || !this.hls || this.video.paused) return
    this.noteProgress()
    if (this.lastProgressAt && Date.now() - this.lastProgressAt >= STREAM_STALL_TIMEOUT) this.failCurrent(new AppError('streamStalled'))
  }

  private queueRemoteStop() {
    this.remoteStop = this.remoteStop.catch(() => {}).then(() => this.api.stopStream())
  }

  private destroyLocal() {
    this.hls?.destroy(); this.hls = undefined
    this.video.pause(); this.video.removeAttribute('src'); this.video.load(); this.video.hidden = true
    this.lastMediaTime = 0
    this.lastProgressAt = 0
  }
}
