"""Private-network HTTP adapter for bounded read-only AgentLoop queries."""

from __future__ import annotations

import json
import os
import signal
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from .core import QueryFailure, create_target, load_secret, query_work

MAX_REQUEST_BYTES = 2048
MAX_RESPONSE_BYTES = 128 * 1024
WORK_FIELDS = {"workId", "fromEpoch", "toEpoch"}
INPUT_CODES = {"WORK_ID_INVALID", "TIME_WINDOW_INVALID"}


def _integer_env(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.environ.get(name, str(default)))
    except ValueError as error:
        raise QueryFailure(f"{name}_INVALID") from error
    if value < minimum or value > maximum:
        raise QueryFailure(f"{name}_INVALID")
    return value


def load_config() -> tuple[Any, dict[str, str], str, int, int]:
    endpoint = os.environ.get("TIANGONG_AGENTLOOP_QUERY_ENDPOINT", "")
    project = os.environ.get("TIANGONG_AGENTLOOP_QUERY_PROJECT", "")
    services_text = os.environ.get("TIANGONG_AGENTLOOP_QUERY_SERVICES", "")
    environment = os.environ.get("TIANGONG_AGENTLOOP_QUERY_ENVIRONMENT", "")
    services = services_text.split(",") if services_text else []
    target = create_target(
        endpoint=endpoint,
        project=project,
        services=services,
        environment=environment,
        max_results=_integer_env("TIANGONG_AGENTLOOP_QUERY_MAX_RESULTS", 80, 1, 100),
        timeout_seconds=_integer_env("TIANGONG_AGENTLOOP_QUERY_TIMEOUT_SECONDS", 5, 1, 30),
    )
    secret_path = os.environ.get("TIANGONG_AGENTLOOP_QUERY_SECRET_FILE", "")
    secret = load_secret(secret_path)
    host = os.environ.get("TIANGONG_AGENTLOOP_QUERY_HOST", "0.0.0.0")
    if host not in ("0.0.0.0", "127.0.0.1"):
        raise QueryFailure("QUERY_HOST_INVALID")
    port = _integer_env("TIANGONG_AGENTLOOP_QUERY_PORT", 8791, 1, 65535)
    concurrency = _integer_env("TIANGONG_AGENTLOOP_QUERY_MAX_CONCURRENCY", 2, 1, 8)
    return target, secret, host, port, concurrency


class AdapterServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], target: Any, secret: dict[str, str], concurrency: int):
        super().__init__(address, AdapterHandler)
        self.target = target
        self.secret = secret
        self.capacity = threading.BoundedSemaphore(concurrency)


class AdapterHandler(BaseHTTPRequestHandler):
    server: AdapterServer

    def log_message(self, _format: str, *_args: Any) -> None:
        return

    def _json(self, status: int, body: dict[str, Any]) -> None:
        encoded = json.dumps(body, sort_keys=True, separators=(",", ":")).encode("utf-8")
        if len(encoded) > MAX_RESPONSE_BYTES:
            status = 502
            encoded = b'{"error":"QUERY_RESPONSE_TOO_LARGE"}'
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("cache-control", "no-store")
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self) -> None:
        if self.path == "/healthz":
            self._json(200, {"ok": True})
        elif self.path == "/readyz":
            self._json(200, {"ready": True, "source": "validated-config"})
        else:
            self._json(404, {"error": "NOT_FOUND"})

    def do_POST(self) -> None:
        if self.path != "/v1/traces/query":
            self._json(404, {"error": "NOT_FOUND"})
            return
        if self.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
            self._json(415, {"error": "CONTENT_TYPE_INVALID"})
            return
        try:
            length = int(self.headers.get("content-length", ""))
        except ValueError:
            self._json(422, {"error": "REQUEST_BODY_INVALID"})
            return
        if length < 2 or length > MAX_REQUEST_BYTES:
            self._json(413 if length > MAX_REQUEST_BYTES else 422, {"error": "REQUEST_BODY_INVALID"})
            return
        try:
            body = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._json(422, {"error": "REQUEST_BODY_INVALID"})
            return
        if not isinstance(body, dict) or set(body) != WORK_FIELDS:
            self._json(422, {"error": "REQUEST_BODY_INVALID"})
            return
        if not self.server.capacity.acquire(blocking=False):
            self._json(503, {"error": "QUERY_CAPACITY_EXCEEDED"})
            return
        try:
            result = query_work(
                target=self.server.target,
                secret=self.server.secret,
                work_id=body.get("workId"),
                from_epoch=body.get("fromEpoch"),
                to_epoch=body.get("toEpoch"),
            )
            self._json(200, result)
        except QueryFailure as error:
            code = str(error) if str(error).isupper() and len(str(error)) <= 96 else "QUERY_FAILED"
            self._json(422 if code in INPUT_CODES else 502, {"error": code})
        finally:
            self.server.capacity.release()

    def do_PUT(self) -> None:
        self._json(405, {"error": "METHOD_NOT_ALLOWED"})

    do_DELETE = do_PUT
    do_PATCH = do_PUT


def main() -> None:
    try:
        target, secret, host, port, concurrency = load_config()
        server = AdapterServer((host, port), target, secret, concurrency)
    except QueryFailure:
        raise SystemExit(1)

    stopping = threading.Event()

    def shutdown(_signal: int, _frame: Any) -> None:
        if stopping.is_set():
            return
        stopping.set()
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    print(f"tiangong_agentloop_query_adapter_listening={port}", flush=True)
    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
