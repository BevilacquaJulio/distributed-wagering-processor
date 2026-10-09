FROM oven/bun:1.4.2 AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.2 AS build
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
RUN bun run build

FROM oven/bun:1.4.2 AS runtime
WORKDIR /app
ENV HOST=0.0.0.0 PORT=3000
COPY --from=dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --from=build --chown=bun:bun /app/dist ./dist
COPY --chown=bun:bun package.json ./
USER bun
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 CMD bun -e "const r = await fetch('http://127.0.0.1:3000/health/ready', { signal: AbortSignal.timeout(4000) }); process.exit(r.ok ? 0 : 1)"
CMD ["bun", "dist/main.js"]
