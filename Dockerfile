FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Empty defaults — DB (Supabase) is source of truth; server restores data on startup
# (conversations, profile, topics-used, templates, session-memories all sync from DB).
# No root.crt on Linux → server uses rejectUnauthorized:false for Supabase (still encrypted).
RUN mkdir -p data && \
    echo '[]' > data/conversations.json && \
    echo '{}' > data/voice-profile.json && \
    echo '{}' > data/topics-used.json

ENV NODE_ENV=production
ENV PORT=7860
EXPOSE 7860

CMD ["node", "server/index.js"]
