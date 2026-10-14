# agentes Cloud image: API, workers and the web app in one Bun process.
FROM oven/bun:1.3.1
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile \
 && bun run --filter '@agenteschat/web' build
ENV NODE_ENV=production \
    WEB_DIR=/app/apps/web/dist \
    PORT=3000
USER bun
EXPOSE 3000
CMD ["bun", "apps/server/src/main.ts"]
