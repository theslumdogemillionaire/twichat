import { TwitchIrc } from '../src/main/irc'

const requested = process.argv[2]
const channel = requested ?? 'twitch'
const irc = new TwitchIrc()
let connected = false
let joined = false
let messages = 0
const finish = () => {
  if (!connected || !joined || (requested && messages === 0)) return
  clearTimeout(timer)
  irc.disconnect()
  console.log(`Twitch IRC: anonymous connection, channel #${channel} and ${messages} message${messages > 1 ? 's' : ''} validated.`)
}
const timer = setTimeout(() => {
  irc.disconnect()
  throw new Error(`The chat for #${channel} did not respond: connected=${connected}, joined=${joined}, messages=${messages}.`)
}, 15000)
irc.on('event', event => {
  if (event.type === 'status' && event.status === 'connected') connected = true
  if (event.type === 'joined' && event.channel === channel) joined = true
  if (event.type === 'message' && event.message.channel === channel) messages++
  finish()
})
irc.join(channel)
irc.connect()
