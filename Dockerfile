# syntax=docker/dockerfile:1
#
# Production image.
#
# Runs the `output: 'standalone'` server bundle, which is the same artifact that
# was exercised locally in this repository (`node .next/standalone/server.js`).
# The image runs a long-lived Node process, which is what the settlement
# scheduler needs — see DECISIONS.md D3.
#
# Note on verification: the standalone server command this image runs was tested
# end to end, but `docker build` itself could not be run in the development
# environment (no Docker daemon available). Treat the image as unverified until
# a real build is done.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# prepare-standalone.mjs copies .next/static, public/ and the migration runner
# into the standalone tree, so the runner image needs a single COPY.
RUN npm run build && node scripts/prepare-standalone.mjs

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Do not run as root.
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health > /dev/null || exit 1

# Migrations are a release step, not a boot step: run
#   node scripts/migrate.mjs
# once per deployment before starting the server (see README "Deployment").
CMD ["node", "server.js"]
