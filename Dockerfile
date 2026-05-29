FROM node:20-alpine

RUN apk add --no-cache curl

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# CockroachDB cluster CA cert — required for SSL verification on Linux.
# Node.js's built-in CA bundle does not include CockroachDB's cluster CA.
RUN mkdir -p /root/.postgresql && \
    curl -fsSL -o /root/.postgresql/root.crt \
    'https://cockroachlabs.cloud/clusters/72abce99-7095-4c7f-9ed1-278a7c309471/cert'

# Empty defaults — DB is source of truth; server restores data on startup.
RUN mkdir -p data && \
    echo '[]' > data/conversations.json && \
    echo '{}' > data/voice-profile.json && \
    echo '[]' > data/topics-used.json

ENV NODE_ENV=production
ENV PORT=7860
EXPOSE 7860

CMD ["node", "server/index.js"]
