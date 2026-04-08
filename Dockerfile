# ── Build ─────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install

COPY . .
RUN npm run build

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

# yt-dlp is used for YouTube transcript extraction. It handles bot-detection
# evasion (signature deciphering, alternate client identities) that raw HTTP
# fetching cannot — see worker/youtube.ts.
RUN apk add --no-cache yt-dlp

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json /app/package-lock.json ./
RUN npm install --omit=dev --ignore-scripts

ENV NODE_ENV=production
EXPOSE 4000

CMD ["node", "dist/main.js"]
