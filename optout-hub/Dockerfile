# Universal Opt-Out Synchronization Hub — application image.
#
# The app runs TypeScript directly via `tsx` (no build step), exactly as it runs
# in development and on the reference deployment. `tsx`/`typescript` are therefore
# RUNTIME dependencies, so we install the full dependency set (--include=dev).
#
# Node 20 (matches CI). Runs as the non-root `node` user, under tini for proper
# signal handling, and applies database migrations on start.

FROM node:20-bookworm-slim

# tini = a real PID 1 (forwards signals, reaps zombies).
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first (better layer caching). --include=dev because the app RUNS
# via tsx, which lives in devDependencies (no compile step).
COPY package.json package-lock.json ./
RUN npm ci --include=dev && npm cache clean --force

# Application source (src/, web/, db/migrations/, entrypoint, etc.).
COPY . .

RUN chmod +x docker-entrypoint.sh && chown -R node:node /app
USER node

EXPOSE 3000

# Liveness via the app's own readiness-independent health endpoint. Node 20 ships
# a global fetch, so no curl/wget needed in the image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini → entrypoint (migrate, then start the server with the same PID via exec).
ENTRYPOINT ["/usr/bin/tini", "--", "./docker-entrypoint.sh"]
