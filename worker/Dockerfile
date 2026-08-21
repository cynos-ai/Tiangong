ARG AGENTTEAMS_WORKER_IMAGE=higress-registry.cn-hangzhou.cr.aliyuncs.com/agentteams/agentteams-worker@sha256:daf587ad042f9564abb2347db5c4205ecc25d1b322e09fdd0d58a2a16c2d5c85
FROM ${AGENTTEAMS_WORKER_IMAGE} AS worker-base

ARG TIANGONG_OTEL_EXPORTER_ENDPOINT=""
ARG TIANGONG_NPM_REGISTRY=https://registry.npmjs.org

LABEL org.opencontainers.image.title="Tiangong Worker"
LABEL org.opencontainers.image.description="AgentTeams Worker image with the pinned OpenClaw built-in runtime"
LABEL org.opencontainers.image.licenses="Apache-2.0"
LABEL org.opencontainers.image.source="https://github.com/cynos-ai/Tiangong"

WORKDIR /opt/tiangong-worker
COPY package.json package-lock.json ./
COPY scripts/ ./scripts/
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund --registry="${TIANGONG_NPM_REGISTRY}" \
    && ln -s /opt/openclaw ./node_modules/openclaw \
    && npm cache clean --force \
    && test -x /usr/bin/git \
    && test -x /usr/bin/prlimit \
    && test -x /usr/bin/flock \
    && test ! -L /usr/bin/git \
    && test ! -L /usr/bin/prlimit \
    && test ! -L /usr/bin/flock \
    && test "$(stat -c '%F:%u' /usr/bin/git)" = "regular file:0" \
    && test "$(stat -c '%F:%u' /usr/bin/prlimit)" = "regular file:0" \
    && test "$(stat -c '%F:%u' /usr/bin/flock)" = "regular file:0" \
    && test "$(/usr/bin/git --version)" = "git version 2.43.0" \
    && test "$(/usr/bin/prlimit --version | head -n 1)" = "prlimit from util-linux 2.39.3" \
    && test "$(/usr/bin/flock --version | head -n 1)" = "flock from util-linux 2.39.3" \
    && test -d /usr/lib/git-core \
    && test ! -L /usr/lib/git-core \
    && test "$(stat -c '%F:%u' /usr/lib/git-core)" = "directory:0"

COPY agent/ ./agent/
COPY openclaw-workspace-tools.json ./openclaw-workspace-tools.json
COPY agent-packages/ ./agent-packages/
COPY skills/ ./skills/
COPY observability/ ./observability/
COPY --chmod=755 plugin/ ./plugin/
RUN npm run check-observability \
    && node --input-type=module -e 'import("./agent/packages/loader.mjs").then(async ({loadAgentPackages}) => { const value = await loadAgentPackages(); if (value.packages.length !== 6) process.exit(1); })' \
    && node ./scripts/verify-openclaw-workspace-tools.mjs \
    && node -e 'import("./plugin/index.mjs").then((module) => { if (module.default?.id !== "tiangong-control") process.exit(1); })'

COPY --chmod=755 bin/openclaw /opt/tiangong-worker/bin/

ENV PATH="/opt/tiangong-worker/bin:/opt/tiangong-worker/node_modules/.bin:${PATH}" \
    OPENCLAW_AGENT_HARNESS_FALLBACK=none \
    OPENCLAW_AGENT_RUNTIME=pi \
    TIANGONG_OTEL_EXPORTER_ENDPOINT="${TIANGONG_OTEL_EXPORTER_ENDPOINT}"

WORKDIR /root/agentteams-fs

# One generic runtime image. AgentTeams identity, MemberConfig, Agent package,
# and ControlProfile select responsibility, current model, Skills, and workspace binding.
FROM worker-base AS tg-worker
FROM tg-worker AS default
