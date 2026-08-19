ARG NODE_IMAGE=node:22.23.2-bookworm-slim
FROM ${NODE_IMAGE}

LABEL org.opencontainers.image.title="Tiangong Coordination runtime"
LABEL org.opencontainers.image.description="Deployment-owned PG Coordination API, Web UI, and Matrix wake consumer"
LABEL org.opencontainers.image.licenses="Apache-2.0"
LABEL org.opencontainers.image.source="https://github.com/cynos-ai/Tiangong"

WORKDIR /opt/tiangong

COPY app/package.json app/package-lock.json ./app/
RUN npm --prefix app ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm --prefix app cache clean --force

# The runtime imports only public Tiangong coordination modules. Keeping these
# modules in the image makes the deployment boundary independent of a Worker
# container and avoids copying any Worker state or credentials.
COPY app/ ./app/
COPY worker/agent/ ./worker/agent/
COPY worker/agent-packages/ ./worker/agent-packages/
COPY worker/skills/ ./worker/skills/
COPY app/coordination-entrypoint.sh /usr/local/bin/tiangong-coordination-entrypoint
RUN chmod 755 /usr/local/bin/tiangong-coordination-entrypoint

ENV NODE_ENV=production \
    TIANGONG_COORDINATION_PORT=8780

USER root
ENTRYPOINT ["/usr/local/bin/tiangong-coordination-entrypoint"]
