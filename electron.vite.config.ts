import { defineConfig } from 'electron-vite'
import { resolve } from 'node:path'

export default defineConfig({
  main: {},
  // Sandboxed Electron preloads run as a bundled CommonJS script.
  preload: { build: { rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.cjs' } } } },
  renderer: {
    resolve: { alias: { '@': resolve('src/renderer') } },
    server: { host: '127.0.0.1' },
    // Two pages: the room, and the window the video moves into when it is detached.
    build: {
      target: 'es2022',
      rollupOptions: { input: { index: resolve('src/renderer/index.html'), player: resolve('src/renderer/player.html') } }
    }
  }
})
