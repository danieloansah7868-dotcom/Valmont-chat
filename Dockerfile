# syntax=docker/dockerfile:1.7
FROM node:22.18.0-alpine3.22

ENV NODE_ENV=production \
    PORT=3000 \
    VCHAT_DATA_DIR=/var/lib/vchat
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

COPY --chown=node:node index.html server.js ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node public ./public
COPY --chown=node:node scripts ./scripts
RUN mkdir -p /var/lib/vchat/media && chown -R node:node /var/lib/vchat

USER node
EXPOSE 3000
VOLUME ["/var/lib/vchat"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/readyz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
