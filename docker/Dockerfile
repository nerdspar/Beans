# Multi-stage build producing ONE image that serves both the API and the built static frontend.
#
# Not verified end to end yet — there is no container runtime on the development machine, and the
# web app does not exist until milestone 6. The database half of docker-compose.yml is in use now;
# this half gets exercised when there is a frontend to bundle.

# ------------------------------------------------------------------------------------------------
FROM node:22-alpine AS base

ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app

# ------------------------------------------------------------------------------------------------
# Dependencies, cached independently of source changes.
FROM base AS deps

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# ------------------------------------------------------------------------------------------------
FROM base AS build

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY . .

RUN pnpm build

# Strip dev dependencies from what gets copied forward.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod

# ------------------------------------------------------------------------------------------------
FROM base AS runtime

ENV NODE_ENV=production

# Run unprivileged. The node image ships a `node` user for exactly this.
USER node

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
# Migrations ship as SQL files and run on startup, idempotently.
COPY --from=build --chown=node:node /app/apps/api/src/db/migrations ./apps/api/dist/migrations
# The built SPA, served as static files by the same Fastify process.
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist
COPY --from=build --chown=node:node /app/packages/shared ./packages/shared

EXPOSE 3000

CMD ["node", "apps/api/dist/index.js"]
