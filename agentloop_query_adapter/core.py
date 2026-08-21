"""Validated SLS query and allowlisted AgentLoop span projection."""

from __future__ import annotations

import json
import os
import re
import stat
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

EXPECTED_SECRET_FIELDS = {
    "ALIBABA_CLOUD_ACCESS_KEY_ID",
    "ALIBABA_CLOUD_ACCESS_KEY_SECRET",
}
VALUE_PATTERN = re.compile(r"^[^\s\x00-\x1f\x7f]+$")
NAME_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$")
ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$")
TRACE_ID_PATTERN = re.compile(r"^[0-9a-fA-F]{16,32}$")
SPAN_ID_PATTERN = re.compile(r"^[0-9a-fA-F]{16,32}$")
NANOS_PATTERN = re.compile(r"^[0-9]{1,20}$")
MAX_SECRET_BYTES = 8192
MAX_RESULTS = 100
MAX_SERVICES = 8
MAX_TOKEN_COUNT = 1_000_000_000


class QueryFailure(Exception):
    """A bounded failure safe to expose without backend details."""


@dataclass(frozen=True)
class QueryTarget:
    endpoint: str
    project: str
    services: tuple[str, ...]
    environment: str
    max_results: int = 80
    timeout_seconds: int = 5


def load_secret(path_text: str) -> dict[str, str]:
    if not path_text:
        raise QueryFailure("QUERY_SECRET_FILE_REQUIRED")
    path = Path(os.path.abspath(Path(path_text).expanduser()))
    try:
        metadata = path.lstat()
    except OSError as error:
        raise QueryFailure("QUERY_SECRET_FILE_INVALID") from error
    if not stat.S_ISREG(metadata.st_mode) or path.is_symlink():
        raise QueryFailure("QUERY_SECRET_FILE_UNSAFE")
    if os.name != "nt" and ((metadata.st_mode & 0o077) != 0 or metadata.st_uid != os.getuid()):
        raise QueryFailure("QUERY_SECRET_FILE_UNSAFE")
    try:
        raw = path.read_bytes()
    except OSError as error:
        raise QueryFailure("QUERY_SECRET_FILE_INVALID") from error
    if len(raw) > MAX_SECRET_BYTES or b"\r" in raw:
        raise QueryFailure("QUERY_SECRET_FILE_INVALID")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as error:
        raise QueryFailure("QUERY_SECRET_FILE_INVALID") from error

    values: dict[str, str] = {}
    for line in text.split("\n"):
        if not line:
            continue
        if "=" not in line:
            raise QueryFailure("QUERY_SECRET_FILE_INVALID")
        key, value = line.split("=", 1)
        if key not in EXPECTED_SECRET_FIELDS or key in values or not VALUE_PATTERN.fullmatch(value):
            raise QueryFailure("QUERY_SECRET_FILE_INVALID")
        values[key] = value
    if values.keys() != EXPECTED_SECRET_FIELDS:
        raise QueryFailure("QUERY_SECRET_FILE_INCOMPLETE")
    return values


def bounded_name(value: str, code: str, pattern: re.Pattern[str] = NAME_PATTERN) -> str:
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise QueryFailure(code)
    return value


def validate_endpoint(endpoint_value: str, project_value: str) -> tuple[str, str]:
    project = bounded_name(project_value, "PROJECT_INVALID")
    endpoint_text = endpoint_value if "://" in endpoint_value else f"https://{endpoint_value}"
    endpoint = urlparse(endpoint_text)
    try:
        endpoint_port = endpoint.port
    except ValueError as error:
        raise QueryFailure("ENDPOINT_INVALID") from error
    if (
        endpoint.scheme != "https"
        or endpoint.username
        or endpoint.password
        or endpoint_port not in (None, 443)
        or endpoint.path not in ("", "/")
        or endpoint.params
        or endpoint.query
        or endpoint.fragment
        or not endpoint.hostname
        or not endpoint.hostname.endswith(".log.aliyuncs.com")
        or not endpoint.hostname.startswith(f"{project}.")
    ):
        raise QueryFailure("ENDPOINT_INVALID")
    return endpoint.hostname, project


def create_target(
    *,
    endpoint: str,
    project: str,
    services: Iterable[str],
    environment: str,
    max_results: int = 80,
    timeout_seconds: int = 5,
) -> QueryTarget:
    hostname, project_name = validate_endpoint(endpoint, project)
    service_values = tuple(services)
    if not 1 <= len(service_values) <= MAX_SERVICES or len(set(service_values)) != len(service_values):
        raise QueryFailure("SERVICES_INVALID")
    for service in service_values:
        bounded_name(service, "SERVICE_INVALID")
    bounded_name(environment, "ENVIRONMENT_INVALID")
    if not isinstance(max_results, int) or not 1 <= max_results <= MAX_RESULTS:
        raise QueryFailure("RESULT_LIMIT_INVALID")
    if not isinstance(timeout_seconds, int) or not 1 <= timeout_seconds <= 30:
        raise QueryFailure("QUERY_TIMEOUT_INVALID")
    return QueryTarget(hostname, project_name, service_values, environment, max_results, timeout_seconds)


def validate_window(from_epoch: int, to_epoch: int) -> None:
    if (
        not isinstance(from_epoch, int)
        or isinstance(from_epoch, bool)
        or not isinstance(to_epoch, int)
        or isinstance(to_epoch, bool)
        or from_epoch < 0
        or to_epoch <= from_epoch
        or to_epoch - from_epoch > 86400
    ):
        raise QueryFailure("TIME_WINDOW_INVALID")


def object_field(contents: dict[str, Any], *keys: str) -> dict[str, Any]:
    for key in keys:
        value = contents.get(key)
        if isinstance(value, dict):
            return value
        if isinstance(value, str):
            try:
                decoded = json.loads(value)
            except json.JSONDecodeError:
                continue
            if isinstance(decoded, dict):
                return decoded
    return {}


def _bounded_text(value: Any, limit: int) -> str | None:
    return value if isinstance(value, str) and 0 < len(value) <= limit and "\x00" not in value else None


def _first(contents: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in contents:
            return contents[key]
    return None


def _hex_id(contents: dict[str, Any], pattern: re.Pattern[str], *keys: str) -> str | None:
    value = _first(contents, *keys)
    return value.lower() if isinstance(value, str) and pattern.fullmatch(value) else None


def _nanos(contents: dict[str, Any], *keys: str) -> str | None:
    value = _first(contents, *keys)
    text = str(value) if isinstance(value, int) and not isinstance(value, bool) else value
    return text if isinstance(text, str) and NANOS_PATTERN.fullmatch(text) else None


def _token(attributes: dict[str, Any], *keys: str) -> int | None:
    for key in keys:
        value = attributes.get(key)
        if isinstance(value, str) and value.isdigit():
            value = int(value)
        if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= MAX_TOKEN_COUNT:
            return value
    return None


def _environment(attributes: dict[str, Any], resources: dict[str, Any]) -> str | None:
    for source in (attributes, resources):
        value = source.get("deployment.environment") or source.get("deployment.environment.name")
        if isinstance(value, str):
            return value
    return None


def _duration_ms(contents: dict[str, Any], start: str | None, end: str | None) -> float | None:
    duration = _nanos(contents, "duration", "durationNano", "duration_nano")
    if duration is None and start is not None and end is not None and int(end) >= int(start):
        duration = str(int(end) - int(start))
    if duration is None:
        return None
    value = int(duration) / 1_000_000
    return round(value, 3) if value <= 86_400_000 else None


def project_span(contents: dict[str, Any], *, service: str, work_id: str, environment: str) -> dict[str, Any] | None:
    if not isinstance(contents, dict):
        raise QueryFailure("QUERY_RESPONSE_INVALID")
    observed_service = _first(contents, "serviceName", "service")
    if observed_service != service:
        raise QueryFailure("SERVICE_SCOPE_MISMATCH")
    attributes = object_field(contents, "attributes", "attribute")
    resources = object_field(contents, "resources", "resource")
    if attributes.get("tiangong.work.id") != work_id:
        return None
    if _environment(attributes, resources) != environment:
        raise QueryFailure("ENVIRONMENT_SCOPE_MISMATCH")

    trace_id = _hex_id(contents, TRACE_ID_PATTERN, "traceID", "traceId", "trace_id")
    span_id = _hex_id(contents, SPAN_ID_PATTERN, "spanID", "spanId", "span_id")
    parent_span_id = _hex_id(contents, SPAN_ID_PATTERN, "parentSpanID", "parentSpanId", "parent_span_id")
    name = _bounded_text(_first(contents, "spanName", "name"), 256)
    if trace_id is None or span_id is None or name is None:
        raise QueryFailure("SPAN_SCHEMA_INVALID")

    kind = _bounded_text(_first(contents, "spanKind", "kind"), 32)
    kind = {"0": "UNSPECIFIED", "1": "INTERNAL", "2": "SERVER", "3": "CLIENT", "4": "PRODUCER", "5": "CONSUMER"}.get(kind, kind)
    status = _bounded_text(_first(contents, "statusCode", "status_code"), 32)
    status = {"0": "UNSET", "1": "OK", "2": "ERROR"}.get(status, status)
    if status not in ("OK", "ERROR", "UNSET"):
        status = "UNKNOWN"
    start = _nanos(contents, "start", "startTime", "startTimeUnixNano", "start_time_unix_nano")
    end = _nanos(contents, "end", "endTime", "endTimeUnixNano", "end_time_unix_nano")
    task_id_value = attributes.get("tiangong.task.id")
    task_id = task_id_value if isinstance(task_id_value, str) and ID_PATTERN.fullmatch(task_id_value) else None
    model = None
    for key in ("gen_ai.response.model", "gen_ai.request.model", "gen_ai.request.model_name"):
        model = _bounded_text(attributes.get(key), 128)
        if model:
            break
    input_tokens = _token(attributes, "gen_ai.usage.input_tokens", "gen_ai.usage.prompt_tokens")
    output_tokens = _token(attributes, "gen_ai.usage.output_tokens", "gen_ai.usage.completion_tokens")
    total_tokens = _token(attributes, "gen_ai.usage.total_tokens")
    usage = None
    if input_tokens is not None or output_tokens is not None or total_tokens is not None:
        usage = {"inputTokens": input_tokens, "outputTokens": output_tokens, "totalTokens": total_tokens}

    return {
        "traceId": trace_id,
        "spanId": span_id,
        "parentSpanId": parent_span_id,
        "service": service,
        "name": name,
        "kind": kind,
        "startEpochNanos": start,
        "endEpochNanos": end,
        "durationMs": _duration_ms(contents, start, end),
        "statusCode": status,
        "model": model,
        "workId": work_id,
        "taskId": task_id,
        "usage": usage,
    }


def _default_client_factory(target: QueryTarget, secret: dict[str, str]) -> Any:
    try:
        from aliyun.log import LogClient  # type: ignore[import-not-found]
    except ImportError as error:
        raise QueryFailure("ALIYUN_LOG_SDK_REQUIRED") from error
    client = LogClient(
        target.endpoint,
        secret["ALIBABA_CLOUD_ACCESS_KEY_ID"],
        secret["ALIBABA_CLOUD_ACCESS_KEY_SECRET"],
    )
    client.timeout = target.timeout_seconds
    return client


def query_work(
    *,
    target: QueryTarget,
    secret: dict[str, str],
    work_id: str,
    from_epoch: int,
    to_epoch: int,
    client_factory: Callable[[QueryTarget, dict[str, str]], Any] = _default_client_factory,
) -> dict[str, Any]:
    bounded_name(work_id, "WORK_ID_INVALID", ID_PATTERN)
    validate_window(from_epoch, to_epoch)
    try:
        client = client_factory(target, secret)
        projected: dict[tuple[str, str], dict[str, Any]] = {}
        truncated = False
        backend_records = 0
        for service in target.services:
            response = client.get_log(
                target.project,
                "logstore-tracing",
                from_epoch,
                to_epoch,
                "",
                f'"{service}" and "{work_id}"',
                True,
                0,
                target.max_results,
            )
            logs = response.get_logs()
            if not isinstance(logs, list):
                raise QueryFailure("QUERY_RESPONSE_INVALID")
            backend_records += len(logs)
            if len(logs) >= target.max_results:
                truncated = True
            for log in logs:
                contents = log.get_contents()
                span = project_span(contents, service=service, work_id=work_id, environment=target.environment)
                if span is None:
                    continue
                key = (span["traceId"], span["spanId"])
                previous = projected.get(key)
                if previous is not None and previous != span:
                    raise QueryFailure("DUPLICATE_SPAN_CONFLICT")
                projected[key] = span
                if len(projected) > target.max_results:
                    truncated = True
        spans = sorted(projected.values(), key=lambda item: (item["startEpochNanos"] or "", item["traceId"], item["spanId"]))
        if len(spans) > target.max_results:
            spans = spans[: target.max_results]
        return {
            "version": 1,
            "availability": "observed" if spans else "unknown",
            "complete": not truncated,
            "truncated": truncated,
            "workId": work_id,
            "environment": target.environment,
            "services": list(target.services),
            "fromEpoch": from_epoch,
            "toEpoch": to_epoch,
            "backendRecordCount": min(backend_records, target.max_results * len(target.services)),
            "spanCount": len(spans),
            "spans": spans,
            "rawContentEmitted": False,
        }
    except QueryFailure:
        raise
    except Exception as error:  # SDK/backend exceptions may contain sensitive request context.
        raise QueryFailure("QUERY_FAILED") from error
