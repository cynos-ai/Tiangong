ARG AGENTTEAMS_WORKER_IMAGE=higress-registry.cn-hangzhou.cr.aliyuncs.com/agentteams/agentteams-worker@sha256:daf587ad042f9564abb2347db5c4205ecc25d1b322e09fdd0d58a2a16c2d5c85
FROM ${AGENTTEAMS_WORKER_IMAGE} AS worker-base

ARG TIANGONG_OTEL_EXPORTER_ENDPOINT=""
ARG TIANGONG_NPM_REGISTRY=https://registry.npmjs.org
ARG AGENTLOOP_OPENCLAW_PLUGIN_VERSION=0.1.5-beta
ARG AGENTLOOP_OPENCLAW_PLUGIN_SHA256=f48f0524beeed4d2ba4301d718fa36f7d24858714ac44aa6b69137fd07d1863f
ARG AGENTLOOP_OPENCLAW_LICENSE_SHA256=43070e2d4e532684de521b885f385d0841030efa2b1a20bafb76133a5e1379c1

LABEL org.opencontainers.image.title="Tiangong Worker"
LABEL org.opencontainers.image.description="AgentTeams Worker image with the pinned OpenClaw built-in runtime"
LABEL org.opencontainers.image.licenses="Apache-2.0"
LABEL org.opencontainers.image.source="https://github.com/cynos-ai/Tiangong"

COPY agentloop-package-lock.json scripts/audit-lockfile.mjs /tmp/
RUN set -eu; \
    plugin_dir=/opt/agentloop/opentelemetry-instrumentation-openclaw; \
    archive=/tmp/agentloop-openclaw.tar.gz; \
    license=/tmp/agentloop-openclaw.LICENSE; \
    mkdir -p "${plugin_dir}" /opt/tiangong-worker/licenses; \
    curl -fsSL --retry 3 "https://github.com/alibaba/loongsuite-js/releases/download/opentelemetry-instrumentation-openclaw/v${AGENTLOOP_OPENCLAW_PLUGIN_VERSION}/opentelemetry-instrumentation-openclaw.tar.gz" -o "${archive}"; \
    curl -fsSL --retry 3 "https://raw.githubusercontent.com/alibaba/loongsuite-js-plugins/60c560a4d35ded23c973b558b4f6c28303b30b20/opentelemetry-instrumentation-openclaw/LICENSE" -o "${license}"; \
    echo "${AGENTLOOP_OPENCLAW_PLUGIN_SHA256}  ${archive}" | sha256sum -c -; \
    echo "${AGENTLOOP_OPENCLAW_LICENSE_SHA256}  ${license}" | sha256sum -c -; \
    tar --extract --gzip --file "${archive}" --strip-components=1 --no-same-owner --no-same-permissions --directory "${plugin_dir}"; \
    cp "${license}" /opt/tiangong-worker/licenses/agentloop-openclaw-Apache-2.0.txt; \
    cd "${plugin_dir}"; \
    node -e 'const fs=require("node:fs"); const path="package.json"; const value=JSON.parse(fs.readFileSync(path,"utf8")); value.dependencies["@opentelemetry/exporter-trace-otlp-proto"]="0.221.0"; value.dependencies["@opentelemetry/resources"]="2.10.0"; value.dependencies["@opentelemetry/sdk-trace-base"]="2.10.0"; fs.writeFileSync(path, JSON.stringify(value, null, 2)+"\n")'; \
    cp /tmp/agentloop-package-lock.json ./package-lock.json; \
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund --registry="${TIANGONG_NPM_REGISTRY}"; \
    node /tmp/audit-lockfile.mjs ./package-lock.json; \
    test "$(node -p 'require("./package.json").version')" = "${AGENTLOOP_OPENCLAW_PLUGIN_VERSION}"; \
    test "$(node -p 'require("./package.json").license')" = "Apache-2.0"; \
    test "$(node -p 'require("@opentelemetry/exporter-trace-otlp-proto/package.json").version')" = "0.221.0"; \
    chown -R 0:0 /opt/agentloop /opt/tiangong-worker/licenses; \
    rm -f "${archive}" "${license}"; \
    npm cache clean --force

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
