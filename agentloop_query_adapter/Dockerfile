ARG PYTHON_IMAGE=python:3.12.12-slim-bookworm@sha256:593bd06efe90efa80dc4eee3948be7c0fde4134606dd40d8dd8dbcade98e669c
FROM ${PYTHON_IMAGE}

LABEL org.opencontainers.image.title="Tiangong AgentLoop read-only query adapter"
LABEL org.opencontainers.image.description="Credential-scoped bounded SLS diagnostics adapter"
LABEL org.opencontainers.image.licenses="Apache-2.0"
LABEL org.opencontainers.image.source="https://github.com/cynos-ai/Tiangong"

WORKDIR /opt/tiangong
COPY agentloop_query_adapter/requirements.lock ./agentloop_query_adapter/requirements.lock
RUN pip install --no-cache-dir --disable-pip-version-check -r ./agentloop_query_adapter/requirements.lock
COPY agentloop_query_adapter/ ./agentloop_query_adapter/

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    TIANGONG_AGENTLOOP_QUERY_PORT=8791

USER 65532:65532
ENTRYPOINT ["python", "-m", "agentloop_query_adapter.server"]
