# The fake imei24 for the local stack (see SCENARIOS.md). Dev tooling only, never deployed.
# Multi-arch base, no build step, no npm dependencies.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server.mjs imei-for.mjs gen-certs.sh ./
RUN chmod 755 gen-certs.sh
USER node
EXPOSE 8443
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.mjs"]
