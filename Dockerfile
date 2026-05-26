FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Ensure data dir exists with empty defaults (Neon is source of truth in cloud)
RUN mkdir -p data && \
    echo '{"samples":[],"topWords":[],"topEmojis":[],"sentenceEnders":[],"avgLength":0,"updatedAt":null}' > data/voice-profile.json && \
    echo '[]' > data/conversations.json && \
    echo '[]' > data/topics-used.json

ENV NODE_ENV=production
ENV PORT=7860
EXPOSE 7860

CMD ["node", "server/index.js"]
