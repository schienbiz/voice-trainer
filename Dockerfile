FROM node:20-alpine

RUN apk add --no-cache curl

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# CockroachDB cluster CA cert — required for SSL verification on Linux.
# Non-fatal: if the cert URL changes or is unreachable, the build still succeeds.
# The server falls back to Node.js built-in CAs, which usually work with CockroachDB Serverless.
RUN mkdir -p /root/.postgresql && \
    curl -fsSL -o /root/.postgresql/root.crt \
    'https://cockroachlabs.cloud/clusters/72abce99-7095-4c7f-9ed1-278a7c309471/cert' \
    || echo "[docker] CockroachDB cert download skipped — using system CAs"

# Empty defaults — DB is source of truth; server restores data on startup.
RUN mkdir -p data && \
    echo '[]' > data/conversations.json && \
    echo '{}' > data/voice-profile.json && \
    echo '[]' > data/topics-used.json

ENV NODE_ENV=production
ENV PORT=7860
EXPOSE 7860

CMD ["node", "server/index.js"]
