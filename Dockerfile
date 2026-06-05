FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Empty defaults — DB is source of truth; server restores data on startup.
# CockroachDB cert not needed: Node.js 20 on Linux trusts CockroachDB Serverless
# certs via its built-in CA bundle. Server falls back gracefully if cert absent.
RUN mkdir -p data && \
    echo '[]' > data/conversations.json && \
    echo '{}' > data/voice-profile.json && \
    echo '[]' > data/topics-used.json

ENV NODE_ENV=production
ENV PORT=7860
EXPOSE 7860

CMD ["node", "server/index.js"]
