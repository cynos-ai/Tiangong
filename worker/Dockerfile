ARG AGENTTEAMS_WORKER_IMAGE=higress-registry.cn-hangzhou.cr.aliyuncs.com/agentteams/agentteams-worker@sha256:0e91141495af352660b956de49e0581886ac11b38de7381e46e43424b030fdff
FROM ${AGENTTEAMS_WORKER_IMAGE} AS worker-base

ARG TIANGONG_OTEL_EXPORTER_ENDPOINT=""

LABEL org.opencontainers.image.title="Tiangong Worker"
LABEL org.opencontainers.image.description="AgentTeams Worker image with the public pi coding agent"
LABEL org.opencontainers.image.licenses="Apache-2.0"
LABEL org.opencontainers.image.source="https://github.com/cynos-ai/Tiangong"

WORKDIR /opt/tiangong-worker
COPY package.json package-lock.json ./
COPY scripts/ ./scripts/
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm run patch-dependencies \
    && ln -s /opt/openclaw ./node_modules/openclaw \
    && npm cache clean --force \
    && ./node_modules/.bin/pi --version \
    && test -x /usr/bin/flock \
    && /usr/bin/flock --version

COPY agent/ ./agent/
COPY observability/ ./observability/
COPY plugin/ ./plugin/
COPY roles/ ./roles/
COPY practices/ ./practices/
RUN npm run check-observability \
    && node -e 'import("./plugin/index.mjs").then((module) => { if (module.default?.id !== "tiangong-pi") process.exit(1); })'

COPY --chmod=755 bin/openclaw bin/tiangong-reconcile bin/tiangong-retain /opt/tiangong-worker/bin/

ENV PATH="/opt/tiangong-worker/bin:/opt/tiangong-worker/node_modules/.bin:${PATH}" \
    OPENCLAW_AGENT_HARNESS_FALLBACK=none \
    OPENCLAW_AGENT_RUNTIME=tiangong-pi \
    PI_SKIP_VERSION_CHECK=1 \
    PI_TELEMETRY=0 \
    TIANGONG_OTEL_EXPORTER_ENDPOINT="${TIANGONG_OTEL_EXPORTER_ENDPOINT}"

WORKDIR /root/hiclaw-fs

FROM worker-base AS kernel
COPY role-profiles/kernel.json /opt/tiangong-worker/profile.json
RUN node /opt/tiangong-worker/scripts/check-role-profile.mjs --expect-role kernel

FROM worker-base AS reviewer
COPY role-profiles/reviewer.json /opt/tiangong-worker/profile.json
RUN node /opt/tiangong-worker/scripts/check-role-profile.mjs --expect-role reviewer

FROM kernel AS default
