# TANK CLASH: one container serves the web client and the WebSocket game server.
# Works on any container host (Render, Railway, Koyeb, Northflank, Fly, a VPS…). Listens on $PORT (default 8080).

# ---- build stage: install everything (dev deps are needed to build) and produce the two bundles
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --include=dev
COPY . .
RUN npm run build

# ---- runtime stage: just Node, the two bundles and `ws` (the only runtime dependency; zod etc. are bundled)
FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=8080 \
    CLIENT_DIR=client/dist \
    TRUST_PROXY=1
WORKDIR /app
COPY --from=build /app/node_modules/ws node_modules/ws
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/client/dist client/dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1
CMD ["node", "server/dist/index.js"]
