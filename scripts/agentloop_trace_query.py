#!/usr/bin/env python3
"""Run a bounded, read-only AgentLoop trace query through Alibaba Cloud SLS."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agentloop_query_adapter.core import (
    ID_PATTERN,
    MAX_RESULTS,
    QueryFailure,
    bounded_name,
    load_secret,
    object_field,
    validate_endpoint,
    validate_window,
)


def fail(code: str) -> None:
    print(f"agentloop_trace_query=fail code={code}", file=sys.stderr)
    raise SystemExit(1)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Query one AgentLoop service from SLS without printing raw spans.")
    parser.add_argument("--endpoint", required=True, help="SLS endpoint hostname or HTTPS URL")
    parser.add_argument("--project", required=True, help="SLS project containing logstore-tracing")
    parser.add_argument("--service", required=True, help="Exact AgentLoop serviceName")
    parser.add_argument("--from-epoch", required=True, type=int, help="Inclusive start time in epoch seconds")
    parser.add_argument("--to-epoch", required=True, type=int, help="Exclusive end time in epoch seconds")
    parser.add_argument("--expected-work-id", required=True)
    parser.add_argument("--expected-task-id", required=True)
    parser.add_argument("--expected-environment", default="isolated-test")
    parser.add_argument("--minimum-correlated-spans", type=int, default=1)
    parser.add_argument("--validate-only", action="store_true", help="Validate local inputs without loading the SDK or querying SLS")
    return parser.parse_args()


def validate_args(args: argparse.Namespace) -> str:
    endpoint, _project = validate_endpoint(args.endpoint, args.project)
    bounded_name(args.service, "SERVICE_INVALID")
    bounded_name(args.expected_work_id, "WORK_ID_INVALID", ID_PATTERN)
    bounded_name(args.expected_task_id, "TASK_ID_INVALID", ID_PATTERN)
    bounded_name(args.expected_environment, "ENVIRONMENT_INVALID")
    validate_window(args.from_epoch, args.to_epoch)
    if not 1 <= args.minimum_correlated_spans <= MAX_RESULTS:
        raise QueryFailure("CORRELATED_SPAN_THRESHOLD_INVALID")
    return endpoint


def run_query(args: argparse.Namespace, endpoint: str, secret: dict[str, str]) -> dict[str, Any]:
    try:
        from aliyun.log import LogClient  # type: ignore[import-not-found]
    except ImportError as error:
        raise QueryFailure("ALIYUN_LOG_SDK_REQUIRED") from error

    try:
        client = LogClient(
            endpoint,
            secret["ALIBABA_CLOUD_ACCESS_KEY_ID"],
            secret["ALIBABA_CLOUD_ACCESS_KEY_SECRET"],
        )
        response = client.get_log(
            args.project,
            "logstore-tracing",
            args.from_epoch,
            args.to_epoch,
            "",
            args.service,
            True,
            0,
            MAX_RESULTS,
        )
        logs = response.get_logs()
    except Exception as error:  # Backend exceptions may contain sensitive request context.
        raise QueryFailure("QUERY_FAILED") from error

    if len(logs) >= MAX_RESULTS:
        raise QueryFailure("RESULT_LIMIT_REACHED")

    span_names: set[str] = set()
    trace_ids: set[str] = set()
    correlated = 0
    environment_seen = False
    for log in logs:
        contents = log.get_contents()
        if not isinstance(contents, dict) or contents.get("serviceName") != args.service:
            raise QueryFailure("SERVICE_SCOPE_MISMATCH")
        span_name = contents.get("spanName")
        if isinstance(span_name, str) and len(span_name) <= 256:
            span_names.add(span_name)
        trace_id = contents.get("traceID", contents.get("traceId", contents.get("trace_id")))
        if isinstance(trace_id, str) and re.fullmatch(r"[0-9a-fA-F]{16,32}", trace_id):
            trace_ids.add(trace_id.lower())
        attributes = object_field(contents, "attributes", "attribute")
        resources = object_field(contents, "resources", "resource")
        if attributes.get("deployment.environment") == args.expected_environment or resources.get("deployment.environment") == args.expected_environment:
            environment_seen = True
        if attributes.get("tiangong.work.id") == args.expected_work_id and attributes.get("tiangong.task.id") == args.expected_task_id:
            correlated += 1

    if not logs:
        raise QueryFailure("NO_MATCHING_SPANS")
    if correlated < args.minimum_correlated_spans:
        raise QueryFailure("CORRELATION_NOT_FOUND")
    if not trace_ids:
        raise QueryFailure("TRACE_ID_NOT_FOUND")
    if not environment_seen:
        raise QueryFailure("ENVIRONMENT_MARKER_NOT_FOUND")

    return {
        "agentloop_trace_query": "pass",
        "service": args.service,
        "matching_spans": len(logs),
        "correlated_spans": correlated,
        "trace_count": len(trace_ids),
        "trace_ids": sorted(trace_ids)[:20],
        "span_names": sorted(span_names),
        "environment": args.expected_environment,
        "raw_content_emitted": False,
    }


def main() -> None:
    try:
        args = parse_args()
        secret_path = os.environ.get("TIANGONG_AGENTLOOP_QUERY_SECRET_FILE", "")
        secret = load_secret(secret_path)
        endpoint = validate_args(args)
        if args.validate_only:
            print(json.dumps({"agentloop_trace_query": "ready", "credential_boundary": "external-file"}, separators=(",", ":")))
            return
        print(json.dumps(run_query(args, endpoint, secret), sort_keys=True, separators=(",", ":")))
    except QueryFailure as error:
        fail(str(error))


if __name__ == "__main__":
    main()
