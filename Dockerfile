# One image; CMD selects api or worker. Node 22 because Node 20 lacks native TS stripping and
# reaches end-of-life before this service will.
FROM node:22-bookworm-slim AS build
WORKDIR /app
# Manifests first, so `npm ci` is cached until a dependency actually changes. Every workspace has
# to be listed: npm resolves the whole graph at install time and a missing one fails the install.
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages/contract/package.json packages/contract/
COPY packages/identity/package.json packages/identity/
COPY packages/providers/package.json packages/providers/
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production NODE_OPTIONS=--enable-source-maps
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/apps ./apps
COPY --from=build --chown=node:node /app/testdata ./testdata
# Operator scripts (seed:service-tenant, seed:admin-key, imei:reveal) run inside this container on
# the host; they import only production dependencies and apps/api/dist.
COPY --from=build --chown=node:node /app/scripts ./scripts
COPY --from=build --chown=node:node /app/package.json ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/api/dist/server.js"]
