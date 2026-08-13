# Single-node pilot image. Not a horizontally scaled production cluster.
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000
RUN addgroup -S vchat && adduser -S -G vchat vchat
COPY --from=deps /app/node_modules ./node_modules
COPY --chown=vchat:vchat . .
USER vchat
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null || exit 1
CMD ["node", "server.js"]
