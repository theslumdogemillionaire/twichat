import { createTwichatServer } from './app.mjs'

const port = Number(process.env.PORT ?? 3000)
const host = process.env.HOST ?? '0.0.0.0'
const server = createTwichatServer()
server.listen(port, host, () => {
  console.log(`Twichat web is listening on http://${host}:${port}`)
})

function shutdown() { server.close(() => process.exit(0)) }
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

