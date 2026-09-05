# syntax=docker/dockerfile:1

# The landing site, and it alone. `server/app.mjs` imports nothing but built-in
# Node modules: no dependencies to install, no build step, copy and run. The
# desktop app stays outside the container, since an Electron binary is built
# with electron-builder and has no useful shape here.
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY server/*.mjs ./server/
COPY server/public ./server/public

USER node
EXPOSE 3000

# `/healthz` is the server's health route; wget comes from busybox, nothing to install.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/healthz" >/dev/null || exit 1

CMD ["node", "server/index.mjs"]
