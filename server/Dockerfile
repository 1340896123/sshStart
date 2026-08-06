FROM node:24-alpine

WORKDIR /app
COPY --chown=node:node package.json ./package.json
COPY --chown=node:node src ./src
RUN mkdir -p /data && chown node:node /data

ENV PORTICO_SYNC_HOST=0.0.0.0
ENV PORTICO_SYNC_PORT=8787
ENV PORTICO_SYNC_DATABASE_PATH=/data/portico-sync.sqlite

USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:8787/healthz').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/index.mjs"]
