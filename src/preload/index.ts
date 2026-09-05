import { contextBridge, ipcRenderer } from 'electron'
import { isWireError, wireErrorToError } from '../shared/wire'
import type { BufferMode, ChatEvent, ScopedPreferences, TwichatAPI, UpdateNotice } from '../shared/types'

/**
 * Every invocation goes through here: the main process returns its known errors as an envelope
 * rather than throwing them, since Electron would otherwise carry across nothing but the
 * message. The renderer thus gets back an `Error` holding its key, translatable on its side.
 */
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = await ipcRenderer.invoke(channel, ...args)
  if (isWireError(result)) throw wireErrorToError(result)
  return result as T
}

const api: TwichatAPI = {
  init: () => invoke('app:init'),
  join: channel => invoke('chat:join', channel),
  part: channel => invoke('chat:part', channel),
  send: (channel, text, reply) => invoke('chat:send', channel, text, reply),
  reconnect: () => invoke('chat:reconnect'),
  anonymous: () => invoke('session:anonymous'),
  useSavedAccount: login => invoke('account:use-saved', login),
  savedAvatars: () => invoke('account:avatars'),
  browserLogin: mode => invoke('account:browser-login', mode),
  authenticate: token => invoke('account:authenticate', token),
  logout: () => invoke('account:logout'),
  forgetAccount: login => invoke('account:forget', login),
  savePreferences: (preferences, scope) => invoke('preferences:save', preferences, scope),
  profiles: channels => invoke('rooms:profiles', channels),
  channelActivity: () => invoke('rooms:activity'),
  markChannelActivity: channels => invoke('rooms:mark-activity', channels),
  chatterProfiles: logins => invoke('chatters:profiles', logins),
  userCard: login => invoke('user:card', login),
  channelInfo: (channel, roomId) => invoke('channel:info', channel, roomId ?? ''),
  followStatus: (channel, roomId) => invoke('follow:status', channel, roomId ?? ''),
  thirdPartyEmotes: (channel, roomId) => invoke('emotes:third-party', channel, roomId),
  twitchEmotes: roomId => invoke('emotes:twitch', roomId),
  discover: (language, refresh) => invoke('discover:streams', language, refresh),
  followed: refresh => invoke('discover:followed', refresh),
  resolveStream: (channel, quality) => invoke('stream:resolve', channel, quality),
  stopStream: () => invoke('stream:stop'),
  detachPlayer: (channel, quality, play) => invoke('player:detach', channel, quality, play),
  attachPlayer: () => invoke('player:attach'),
  commandPlayer: (action, channel, quality, buffer) => invoke('player:command', action, channel, quality, buffer),
  playerContext: () => invoke('player:context'),
  reportPlayerState: (state, message) => invoke('player:state', state, message ?? ''),
  reportPlayerQuality: quality => invoke('player:quality', quality),
  reportPlayerVolume: (volume, muted) => invoke('player:volume', volume, muted),
  reportPlayerFrame: (ratio, chrome) => invoke('player:frame', ratio, chrome),
  pinPlayer: pinned => invoke('player:pin', pinned),
  onPlayerDetached: callback => {
    const listener = (_event: unknown, channel: string | null) => callback(channel)
    ipcRenderer.on('app:player-detached', listener)
    return () => ipcRenderer.removeListener('app:player-detached', listener)
  },
  onPlayerCommand: callback => {
    const listener = (_event: unknown, action: 'play' | 'stop', channel: string, quality: string, buffer: BufferMode) => callback(action, channel, quality, buffer)
    ipcRenderer.on('app:player-command', listener)
    return () => ipcRenderer.removeListener('app:player-command', listener)
  },
  onPlayerState: callback => {
    const listener = (_event: unknown, state: string, message: string) => callback(state, message)
    ipcRenderer.on('app:player-state', listener)
    return () => ipcRenderer.removeListener('app:player-state', listener)
  },
  onPlayerQuality: callback => {
    const listener = (_event: unknown, quality: string) => callback(quality)
    ipcRenderer.on('app:player-quality', listener)
    return () => ipcRenderer.removeListener('app:player-quality', listener)
  },
  onPlayerVolume: callback => {
    const listener = (_event: unknown, volume: number, muted: boolean) => callback(volume, muted)
    ipcRenderer.on('app:player-volume', listener)
    return () => ipcRenderer.removeListener('app:player-volume', listener)
  },
  external: (target, channel) => invoke('app:external', target, channel),
  openLink: url => invoke('app:open-link', url),
  copy: text => invoke('app:copy', text),
  notifyMention: mention => invoke('app:notify-mention', mention),
  applyUpdate: () => invoke('app:apply-update'),
  onUpdate: callback => {
    const listener = (_event: unknown, notice: UpdateNotice) => callback(notice)
    ipcRenderer.on('app:update', listener)
    return () => ipcRenderer.removeListener('app:update', listener)
  },
  onMentionOpen: callback => {
    const listener = (_event: unknown, channel: string) => callback(channel)
    ipcRenderer.on('app:mention-open', listener)
    return () => ipcRenderer.removeListener('app:mention-open', listener)
  },
  onPreferences: callback => {
    const listener = (_event: unknown, scoped: ScopedPreferences) => callback(scoped)
    ipcRenderer.on('app:preferences', listener)
    return () => ipcRenderer.removeListener('app:preferences', listener)
  },
  onSettings: callback => {
    const listener = () => callback()
    ipcRenderer.on('app:settings', listener)
    return () => ipcRenderer.removeListener('app:settings', listener)
  },
  onNavigate: callback => {
    const listener = (_event: unknown, direction: 'back' | 'forward') => callback(direction)
    ipcRenderer.on('app:navigate', listener)
    return () => ipcRenderer.removeListener('app:navigate', listener)
  },
  onEvents: callback => {
    const listener = (_event: unknown, events: ChatEvent[]) => callback(events)
    ipcRenderer.on('chat:events', listener)
    return () => ipcRenderer.removeListener('chat:events', listener)
  }
}
contextBridge.exposeInMainWorld('twichat', api)
