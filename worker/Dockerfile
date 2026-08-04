# syntax=docker/dockerfile:1
ARG AGENTTEAMS_WORKER_IMAGE=higress-registry.cn-hangzhou.cr.aliyuncs.com/agentteams/agentteams-worker@sha256:daf587ad042f9564abb2347db5c4205ecc25d1b322e09fdd0d58a2a16c2d5c85
ARG DOCKER_CLI_IMAGE=docker.io/library/docker@sha256:0135662b510037ea581d99c2e5929c5e01185139c0b86986a418bd4da0b98a44
FROM ${DOCKER_CLI_IMAGE} AS docker-cli
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
COPY --from=team_playbooks . /opt/team-playbooks/
COPY observability/ ./observability/
COPY plugin/ ./plugin/
COPY roles/ ./roles/
COPY skills/ ./skills/
RUN npm run check-observability \
    && node -e 'import("./plugin/index.mjs").then((module) => { if (module.default?.id !== "tiangong-pi") process.exit(1); })'

COPY --chmod=755 bin/openclaw bin/tiangong-reconcile bin/tiangong-retain /opt/tiangong-worker/bin/

ENV PATH="/opt/tiangong-worker/bin:/opt/tiangong-worker/node_modules/.bin:${PATH}" \
    OPENCLAW_AGENT_HARNESS_FALLBACK=none \
    OPENCLAW_AGENT_RUNTIME=tiangong-pi \
    PI_SKIP_VERSION_CHECK=1 \
    PI_TELEMETRY=0 \
    TIANGONG_OTEL_EXPORTER_ENDPOINT="${TIANGONG_OTEL_EXPORTER_ENDPOINT}"

WORKDIR /root/agentteams-fs

FROM worker-base AS deployment-service
WORKDIR /opt/tiangong-worker
ENTRYPOINT ["/usr/bin/node", "/opt/tiangong-worker/agent/deployment/service.mjs"]

FROM worker-base AS runner-broker
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /opt/tiangong-worker
ENTRYPOINT ["/usr/bin/node", "/opt/tiangong-worker/agent/runner/broker-server.mjs"]

FROM worker-base AS deployment-broker
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /opt/tiangong-worker
ENTRYPOINT ["/usr/bin/node", "/opt/tiangong-worker/agent/deployment/broker-server.mjs"]

FROM worker-base AS kernel
COPY role-profiles/kernel.json /opt/tiangong-worker/profile.json
RUN node /opt/tiangong-worker/scripts/check-role-profile.mjs --expect-role kernel

FROM worker-base AS leader
COPY role-profiles/leader.json /opt/tiangong-worker/profile.json
RUN node /opt/tiangong-worker/scripts/check-role-profile.mjs --expect-role leader

FROM worker-base AS designer
COPY role-profiles/designer.json /opt/tiangong-worker/profile.json
RUN node /opt/tiangong-worker/scripts/check-role-profile.mjs --expect-role designer

FROM worker-base AS implementor
COPY role-profiles/implementor.json /opt/tiangong-worker/profile.json
RUN node /opt/tiangong-worker/scripts/check-role-profile.mjs --expect-role implementor

FROM worker-base AS assessor
COPY role-profiles/assessor.json /opt/tiangong-worker/profile.json
RUN node /opt/tiangong-worker/scripts/check-role-profile.mjs --expect-role assessor

FROM worker-base AS operator
COPY role-profiles/operator.json /opt/tiangong-worker/profile.json
RUN node /opt/tiangong-worker/scripts/check-role-profile.mjs --expect-role operator

FROM kernel AS default
