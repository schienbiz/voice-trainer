FROM node:20-alpine

RUN apk add --no-cache curl

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# CockroachDB cluster CA cert — best-effort; build succeeds even if unreachable.
# --max-time 10 prevents the build from hanging if the URL is slow/unreachable.
RUN mkdir -p /root/.postgresql && \
    curl -fsSL --max-time 10 --connect-timeout 5 \
      -o /root/.postgresql/root.crt \
      'https://cockroachlabs.cloud/clusters/72abce99-7095-4c7f-9ed1-278a7c309471/cert' \
    && echo "[docker] CockroachDB cert downloaded OK" \
    || echo "[docker] CockroachDB cert skipped — using Node.js built-in CAs"

# Empty defaults — DB is source of truth; server restores data on startup.
RUN mkdir -p data && \
    echo '[]' > data/conversations.json && \
    echo '{}' > data/voice-profile.json && \
    echo '[]' > data/topics-used.json

ENV NODE_ENV=production
ENV PORT=7860
EXPOSE 7860

CMD ["node", "server/index.js"]
