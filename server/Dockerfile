FROM node:24-alpine

WORKDIR /app
COPY --chown=node:node . .
RUN mkdir -p /data && chown node:node /data

ENV PORTICO_SYNC_HOST=0.0.0.0
ENV PORTICO_SYNC_PORT=8787
ENV PORTICO_SYNC_DATABASE_PATH=/data/portico-sync.sqlite

USER node
EXPOSE 8787

CMD ["node", "src/index.mjs"]
