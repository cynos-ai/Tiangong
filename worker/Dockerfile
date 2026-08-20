ARG AGENTTEAMS_WORKER_IMAGE=higress-registry.cn-hangzhou.cr.aliyuncs.com/agentteams/agentteams-worker@sha256:daf587ad042f9564abb2347db5c4205ecc25d1b322e09fdd0d58a2a16c2d5c85
ARG DOCKER_CLI_IMAGE=docker.io/library/docker@sha256:0135662b510037ea581d99c2e5929c5e01185139c0b86986a418bd4da0b98a44
FROM ${DOCKER_CLI_IMAGE} AS docker-cli
FROM ${AGENTTEAMS_WORKER_IMAGE} AS worker-base

ARG TIANGONG_OTEL_EXPORTER_ENDPOINT=""
ARG TIANGONG_NPM_REGISTRY=https://registry.npmjs.org
ARG TIANGONG_CODEX_GATEWAY_HOSTS=agentteams-controller
ARG TIANGONG_CODEX_BASE_URL=

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

COPY --chmod=755 bin/codex bin/codex-app-server bin/openclaw bin/tiangong-reconcile bin/tiangong-retain bin/tiangong-work-run /opt/tiangong-worker/bin/
COPY scripts/codex-app-server-proxy.mjs /opt/tiangong-worker/scripts/codex-app-server-proxy.mjs

ENV PATH="/opt/tiangong-worker/bin:/opt/tiangong-worker/node_modules/.bin:${PATH}" \
    OPENCLAW_AGENT_HARNESS_FALLBACK=none \
    OPENCLAW_AGENT_RUNTIME=pi \
    TIANGONG_CODEX_GATEWAY_HOSTS="${TIANGONG_CODEX_GATEWAY_HOSTS}" \
    TIANGONG_CODEX_BASE_URL="${TIANGONG_CODEX_BASE_URL}" \
    TIANGONG_OTEL_EXPORTER_ENDPOINT="${TIANGONG_OTEL_EXPORTER_ENDPOINT}"

WORKDIR /root/agentteams-fs

FROM worker-base AS deployment-service
WORKDIR /opt/tiangong-worker
ENTRYPOINT ["/usr/bin/node", "/opt/tiangong-worker/agent/deployment/service.mjs"]

FROM worker-base AS codex-capability-cache
WORKDIR /opt/tiangong-worker
ENTRYPOINT ["/usr/bin/node", "/opt/tiangong-worker/agent/preflight/codex-capability-cache-service.mjs"]

FROM worker-base AS runner-broker
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /opt/tiangong-worker
ENTRYPOINT ["/usr/bin/node", "/opt/tiangong-worker/agent/runner/broker-server.mjs"]

FROM worker-base AS admission-control
WORKDIR /opt/tiangong-worker
ENTRYPOINT ["/usr/bin/node", "/opt/tiangong-worker/agent/gates/admission-control-server.mjs"]

FROM worker-base AS deployment-broker
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /opt/tiangong-worker
ENTRYPOINT ["/usr/bin/node", "/opt/tiangong-worker/agent/deployment/broker-server.mjs"]

FROM worker-base AS opencodex-sidecar
RUN npm install --global --no-audit --no-fund --registry="${TIANGONG_NPM_REGISTRY}" \
      @bitkyc08/opencodex@2.15.0 \
    && ocx --version
WORKDIR /opt/tiangong-worker
ENTRYPOINT ["/bin/sh", "-c", "exec sleep infinity"]

FROM worker-base AS opencodex-receipt-service
WORKDIR /opt/tiangong-worker
ENTRYPOINT ["/usr/bin/node", "/opt/tiangong-worker/agent/deployment/opencodex-sidecar-receipt-service.mjs"]

FROM worker-base AS opencodex-adapter
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /opt/tiangong-worker
ENTRYPOINT ["/usr/bin/node", "/opt/tiangong-worker/agent/deployment/opencodex-sidecar-receipt-service.mjs"]

# One generic runtime image. AgentTeams identity, MemberConfig, Agent package,
# and ControlProfile select responsibility, current model, Skills, and workspace binding.
FROM worker-base AS tg-worker
FROM tg-worker AS default

FROM tg-worker AS canary
ARG TIANGONG_CODEX_GATEWAY_HOSTS=agentteams-controller
ARG TIANGONG_CODEX_PROVIDER=agentteams-gateway
ARG TIANGONG_CODEX_MODEL=deepseek-v4-pro
ARG TIANGONG_CODEX_MODEL_ALIAS=
ARG TIANGONG_CODEX_BASE_URL=
ARG TIANGONG_CODEX_CREDENTIAL_SOURCE=agentteams-consumer-token
ARG TIANGONG_CODEX_TRANSPORT=auto
ARG TIANGONG_CODEX_BRIDGE=auto
ARG TIANGONG_CODEX_CAPABILITY_CACHE_PATH=/var/lib/tiangong-capabilities/codex.json
ARG TIANGONG_CODEX_CAPABILITY_CACHE_URL=http://tiangong-codex-capability-cache:8788
ARG TIANGONG_CODEX_CAPABILITY_CACHE_SHARED=1
ENV TIANGONG_RUNTIME_LANE=openclaw-canary \
    TIANGONG_CANARY_REQUIRED=1 \
    TIANGONG_CANARY_ADMISSION=local \
    TIANGONG_CODEX_RUNTIME=1 \
    TIANGONG_CODEX_GATEWAY_HOSTS="${TIANGONG_CODEX_GATEWAY_HOSTS}" \
    TIANGONG_CODEX_PROVIDER="${TIANGONG_CODEX_PROVIDER}" \
    TIANGONG_CODEX_MODEL="${TIANGONG_CODEX_MODEL}" \
    TIANGONG_CODEX_MODEL_ALIAS="${TIANGONG_CODEX_MODEL_ALIAS}" \
    TIANGONG_CODEX_BASE_URL="${TIANGONG_CODEX_BASE_URL}" \
    TIANGONG_CODEX_CREDENTIAL_SOURCE="${TIANGONG_CODEX_CREDENTIAL_SOURCE}" \
    TIANGONG_CODEX_TRANSPORT="${TIANGONG_CODEX_TRANSPORT}" \
    TIANGONG_CODEX_BRIDGE="${TIANGONG_CODEX_BRIDGE}" \
    TIANGONG_CODEX_CAPABILITY_CACHE_PATH="${TIANGONG_CODEX_CAPABILITY_CACHE_PATH}" \
    TIANGONG_CODEX_CAPABILITY_CACHE_URL="${TIANGONG_CODEX_CAPABILITY_CACHE_URL}" \
    TIANGONG_CODEX_CAPABILITY_CACHE_SHARED="${TIANGONG_CODEX_CAPABILITY_CACHE_SHARED}" \
    OPENCLAW_AGENT_RUNTIME=codex \
    OPENCLAW_AGENT_HARNESS_FALLBACK=none

# Gate A admission-control canary: the Worker consumes a deployment-owned
# Control API over the AgentTeams network; binding/replay state stays outside
# the Worker image and is projected by the smoke/deployment owner.
FROM canary AS canary-admission-control
ENV TIANGONG_CANARY_ADMISSION=control \
    TIANGONG_CONTROL_API_REQUIRED=1 \
    TIANGONG_CONTROL_API_URL=http://tiangong-admission-control:8789/healthz \
    TIANGONG_CONTROL_API_ADMISSION_URL=http://tiangong-admission-control:8789/v1/admission \
    TIANGONG_CONTROL_API_TIMEOUT_MS=1500

# Explicit opt-in lane for Chat/Completions-only coding models. The bridge itself
# is AgentTeams-owned and must be reachable through the internal gateway route.
FROM worker-base AS canary-chat-bridge
ARG TIANGONG_CODEX_GATEWAY_HOSTS=agentteams-controller
ARG TIANGONG_CODEX_PROVIDER=agentteams-gateway
ARG TIANGONG_CODEX_MODEL=qwen3.7-plus
ARG TIANGONG_CODEX_MODEL_ALIAS=qwen-coding
ARG TIANGONG_CODEX_BASE_URL=
ARG TIANGONG_CODEX_CREDENTIAL_SOURCE=agentteams-consumer-token
ARG TIANGONG_CODEX_TRANSPORT=responses-via-chat-bridge
ARG TIANGONG_CODEX_BRIDGE=opencodex
ENV TIANGONG_RUNTIME_LANE=openclaw-canary \
    TIANGONG_CANARY_REQUIRED=1 \
    TIANGONG_CANARY_ADMISSION=local \
    TIANGONG_CODEX_RUNTIME=1 \
    TIANGONG_CODEX_GATEWAY_HOSTS="${TIANGONG_CODEX_GATEWAY_HOSTS}" \
    TIANGONG_CODEX_PROVIDER="${TIANGONG_CODEX_PROVIDER}" \
    TIANGONG_CODEX_MODEL="${TIANGONG_CODEX_MODEL}" \
    TIANGONG_CODEX_MODEL_ALIAS="${TIANGONG_CODEX_MODEL_ALIAS}" \
    TIANGONG_CODEX_BASE_URL="${TIANGONG_CODEX_BASE_URL}" \
    TIANGONG_CODEX_CREDENTIAL_SOURCE="${TIANGONG_CODEX_CREDENTIAL_SOURCE}" \
    TIANGONG_CODEX_TRANSPORT="${TIANGONG_CODEX_TRANSPORT}" \
    TIANGONG_CODEX_BRIDGE="${TIANGONG_CODEX_BRIDGE}" \
    OPENCLAW_AGENT_RUNTIME=codex \
    OPENCLAW_AGENT_HARNESS_FALLBACK=none
