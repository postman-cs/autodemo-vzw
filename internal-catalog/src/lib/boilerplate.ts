/**
 * Generate all boilerplate files for a new Flask Lambda service.
 * Everything is generated inline — no remote fetching needed.
 */

export async function fetchBoilerplate(
    _token: string
): Promise<{ path: string; content: string }[]> {
    return [
        { path: "app/__init__.py", content: INIT_PY },
        { path: "app/chaos.py", content: CHAOS_PY },
        { path: "app/routes.py", content: DEFAULT_ROUTES },
        { path: "app/models.py", content: DEFAULT_MODELS },
        { path: "app/dependency_caller.py", content: DEPENDENCY_CALLER },
        { path: "app/wsgi.py", content: WSGI_PY },
        { path: "tests/__init__.py", content: "" },
        { path: "tests/test_health.py", content: TEST_HEALTH },
        { path: "tests/test_chaos.py", content: TEST_CHAOS },
        { path: "requirements.txt", content: REQUIREMENTS },
        { path: "requirements-dev.txt", content: REQUIREMENTS_DEV },
        { path: "Dockerfile", content: DOCKERFILE },
        { path: "index.yaml", content: "# Replaced by spec content during provisioning\n" },
    ];
}

export function generateGitignore(): string {
    return `__pycache__/
*.py[cod]
*.egg-info/
dist/
build/
.eggs/
venv/
.venv/
.vscode/
.idea/
*.swp
.env
.env.local
package/
deployment.zip
`;
}

export function generateEnvExample(projectName: string): string {
    return `# ${projectName}
FLASK_ENV=development
FLASK_DEBUG=1
PORT=5000
OTEL_PROPAGATORS=tracecontext,baggage,b3,b3multi
`;
}

const REQUIREMENTS = `flask>=3.1.3
flask-cors==6.0.0
gunicorn==23.0.0
requests>=2.31.0
`;

const REQUIREMENTS_DEV = `pytest==8.3.4
flake8==7.1.1
black==24.10.0
`;

const INIT_PY = `import os
import uuid
from flask import Flask, request, g
from app.dependency_caller import start_dependency_caller

_TRACE_HEADER_KEYS = (
    "traceparent",
    "tracestate",
    "b3",
    "x-b3-traceid",
    "x-b3-spanid",
    "x-b3-parentspanid",
    "x-b3-sampled",
    "x-b3-flags",
)

def _build_b3_headers(trace_id, span_id, sampled):
    return {
        "b3": f"{trace_id}-{span_id}-{sampled}",
        "x-b3-traceid": trace_id,
        "x-b3-spanid": span_id,
        "x-b3-sampled": sampled,
    }

def _normalize_trace_id(trace_id):
    value = (trace_id or "").strip().lower()
    if len(value) == 16:
        value = value.rjust(32, "0")
    if len(value) != 32 or value == ("0" * 32):
        return ""
    if any(ch not in "0123456789abcdef" for ch in value):
        return ""
    return value

def _normalize_span_id(span_id):
    value = (span_id or "").strip().lower()
    if len(value) != 16 or value == ("0" * 16):
        return ""
    if any(ch not in "0123456789abcdef" for ch in value):
        return ""
    return value

def _normalize_trace_flags(flags):
    value = (flags or "").strip().lower()
    if len(value) != 2 or any(ch not in "0123456789abcdef" for ch in value):
        return ""
    return value

def _fresh_trace_headers():
    trace_id = uuid.uuid4().hex
    span_id = os.urandom(8).hex()
    headers = {"traceparent": f"00-{trace_id}-{span_id}-01"}
    headers.update(_build_b3_headers(trace_id, span_id, "1"))
    return headers

def _parse_traceparent(header):
    parts = (header or "").split("-")
    if len(parts) != 4:
        return None
    _version, trace_id, span_id, flags = parts
    trace_id = _normalize_trace_id(trace_id)
    span_id = _normalize_span_id(span_id)
    flags = _normalize_trace_flags(flags)
    if not trace_id or not span_id or not flags:
        return None
    return trace_id, span_id, flags

def _parse_b3(headers):
    single = headers.get("b3", "").strip().lower()
    if single:
        parts = single.split("-")
        if len(parts) >= 2:
            trace_id = _normalize_trace_id(parts[0])
            span_id = _normalize_span_id(parts[1])
            sampled = parts[2] if len(parts) >= 3 and parts[2] else "1"
            if trace_id and span_id:
                flags = "01" if sampled in ("1", "d") else "00"
                return trace_id, span_id, sampled, flags

    trace_id = _normalize_trace_id(headers.get("x-b3-traceid", ""))
    span_id = _normalize_span_id(headers.get("x-b3-spanid", ""))
    sampled = headers.get("x-b3-sampled", headers.get("x-b3-flags", "1"))
    if trace_id and span_id:
        flags = "01" if sampled in ("1", "d") else "00"
        return trace_id, span_id, sampled, flags
    return None

def _extract_trace_headers():
    incoming = {}
    for key in _TRACE_HEADER_KEYS:
        value = request.headers.get(key, "").strip()
        if value:
            incoming[key] = value

    incoming_tracestate = incoming.get("tracestate", "")
    headers = {}

    tp = _parse_traceparent(incoming.get("traceparent", ""))
    if tp:
        trace_id, span_id, flags = tp
        sampled = "1" if int(flags, 16) & 1 else "0"
        headers["traceparent"] = incoming["traceparent"]
        if incoming_tracestate:
            headers["tracestate"] = incoming_tracestate
        headers.update(_build_b3_headers(trace_id, span_id, sampled))
    else:
        b3 = _parse_b3(incoming)
        if b3:
            trace_id, span_id, sampled, flags = b3
            headers["traceparent"] = f"00-{trace_id}-{span_id}-{flags}"
            headers.update(_build_b3_headers(trace_id, span_id, sampled))
        else:
            headers = _fresh_trace_headers()
    return headers

def create_app():
    app = Flask(__name__)

    @app.before_request
    def _extract_trace():
        g.trace_headers = _extract_trace_headers()

    @app.after_request
    def _inject_trace(response):
        for key, value in getattr(g, "trace_headers", {}).items():
            if value:
                response.headers[key] = value
        return response

    base_path = os.environ.get("API_BASE_PATH", "")

    from app.routes import register_routes
    register_routes(app, base_path)

    # Start background traffic generator for container runtimes
    start_dependency_caller()

    return app
`;

const DEFAULT_ROUTES = `from flask import Flask, jsonify, request
from app.chaos import is_enabled as chaos_is_enabled, set_enabled as set_chaos_enabled

def register_routes(app: Flask, base_path: str = ""):
    @app.route(f"{base_path}/health")
    def health():
        return jsonify({"status": "healthy"})

    @app.route(f"{base_path}/chaos", methods=["GET", "PATCH"])
    def chaos_toggle():
        if request.method == "GET":
            return jsonify({"chaos_enabled": chaos_is_enabled()})
        body = request.get_json(silent=True) or {}
        if "enabled" not in body:
            return jsonify({"error": "bad_request", "message": "enabled boolean is required"}), 400
        set_chaos_enabled(bool(body.get("enabled")))
        return jsonify({"chaos_enabled": chaos_is_enabled()})
`;

const DEFAULT_MODELS = `# Models - auto-generated stub
DATA_STORE = {}
`;

const WSGI_PY = `from app import create_app

app = create_app()

def handler(event, context):
    """AWS Lambda handler using mangum-like WSGI adapter."""
    from io import BytesIO
    import urllib.parse

    raw_path = event.get("rawPath", "/")
    method = event.get("requestContext", {}).get("http", {}).get("method", "GET")
    headers = event.get("headers", {})
    body = event.get("body", "") or ""
    is_base64 = event.get("isBase64Encoded", False)

    if is_base64:
        import base64
        body = base64.b64decode(body)
    else:
        body = body.encode("utf-8")

    query_string = event.get("rawQueryString", "")

    environ = {
        "REQUEST_METHOD": method,
        "PATH_INFO": raw_path,
        "QUERY_STRING": query_string,
        "SERVER_NAME": "lambda",
        "SERVER_PORT": "443",
        "HTTP_HOST": headers.get("host", "lambda"),
        "SERVER_PROTOCOL": "HTTP/1.1",
        "wsgi.input": BytesIO(body),
        "wsgi.errors": BytesIO(),
        "wsgi.url_scheme": "https",
        "CONTENT_TYPE": headers.get("content-type", ""),
        "CONTENT_LENGTH": str(len(body)),
    }

    for key, value in headers.items():
        wsgi_key = "HTTP_" + key.upper().replace("-", "_")
        if wsgi_key not in ("HTTP_CONTENT_TYPE", "HTTP_CONTENT_LENGTH"):
            environ[wsgi_key] = value

    response_started = []
    response_body = []

    def start_response(status, response_headers, exc_info=None):
        response_started.append((status, response_headers))

    result = app(environ, start_response)
    for chunk in result:
        response_body.append(chunk)

    if hasattr(result, "close"):
        result.close()

    status_line, resp_headers = response_started[0]
    status_code = int(status_line.split(" ")[0])
    body_bytes = b"".join(response_body)

    return {
        "statusCode": status_code,
        "headers": {h[0]: h[1] for h in resp_headers},
        "body": body_bytes.decode("utf-8"),
        "isBase64Encoded": False,
    }
`;

const CHAOS_PY = `import os
import random
import threading
import time
import json
from flask import jsonify

_lock = threading.Lock()
_override = None
_started_at = time.monotonic()


def _truthy(value) -> bool:
    if value is None:
        return False
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _warmed_up() -> bool:
    raw = os.environ.get("CHAOS_WARMUP_SECONDS", "900")
    try:
        required = max(0, int(raw))
    except Exception:
        required = 900
    return (time.monotonic() - _started_at) >= required


def get_config() -> dict:
    raw_config = os.environ.get("CHAOS_CONFIG", "{}")
    try:
        parsed = json.loads(raw_config)
        if isinstance(parsed, dict):
            return parsed
    except Exception:
        pass
    return {}


def is_enabled() -> bool:
    global _override
    with _lock:
        if _override is not None:
            return bool(_override)
    if not _warmed_up():
        return False
    
    config = get_config()
    if "enabled" in config:
        return _truthy(config["enabled"])

    return _truthy(os.environ.get("CHAOS_ENABLED", "false"))


def set_enabled(enabled: bool):
    global _override
    with _lock:
        _override = bool(enabled)


def maybe_fail(path: str):
    if not is_enabled():
        return None
    normalized = (path or "").lower()
    if normalized.endswith("/health") or normalized.endswith("/chaos"):
        return None
        
    config = get_config()
    
    # Deterministic seeding per-service + time window
    seed_base = config.get("seed", "default")
    time_window = int(time.time() / 300)  # 5 minute window
    random.seed(f"{seed_base}-{time_window}")

    # Each fault type is evaluated independently with its own rate.
    # Order: timeout (most severe) > error > latency (least disruptive).
    timeout_rate = float(config.get("timeout_rate", 0))
    if timeout_rate > 0 and random.random() < timeout_rate:
        time.sleep(30)
        return jsonify({
            "error": "gateway_timeout",
            "message": "Injected timeout for realism"
        }), 504

    error_rate = float(config.get("error_rate", 0))
    if error_rate > 0 and random.random() < error_rate:
        status_code = int(config.get("status_code", 503))
        return jsonify({
            "error": "chaos_injected",
            "message": f"Injected {status_code} failure for realism",
        }), status_code

    latency_rate = float(config.get("latency_rate", 0))
    if latency_rate > 0 and random.random() < latency_rate:
        delay = float(config.get("latency_ms", 1000)) / 1000.0
        time.sleep(delay)

    return None
`;

const TEST_HEALTH = `from app import create_app

def test_health():
    app = create_app()
    client = app.test_client()
    response = client.get("/health")
    assert response.status_code == 200
    data = response.get_json()
    assert data["status"] == "healthy"
`;

const TEST_CHAOS = `import os
import json
from unittest.mock import patch, call
from app import chaos

def test_is_enabled_default(monkeypatch):
    if "CHAOS_ENABLED" in os.environ:
        monkeypatch.delenv("CHAOS_ENABLED")
    if "CHAOS_CONFIG" in os.environ:
        monkeypatch.delenv("CHAOS_CONFIG")
    assert not chaos.is_enabled()

def test_is_enabled_env(monkeypatch):
    monkeypatch.setenv("CHAOS_ENABLED", "true")
    assert chaos.is_enabled()

def test_is_enabled_config(monkeypatch):
    monkeypatch.setenv("CHAOS_CONFIG", json.dumps({"enabled": True}))
    assert chaos.is_enabled()

    monkeypatch.setenv("CHAOS_CONFIG", json.dumps({"enabled": False}))
    monkeypatch.setenv("CHAOS_ENABLED", "true")
    assert not chaos.is_enabled()  # config overrides env

def test_maybe_fail_health_exempt(monkeypatch):
    monkeypatch.setenv("CHAOS_ENABLED", "true")
    assert chaos.maybe_fail("/health") is None
    assert chaos.maybe_fail("/chaos") is None

@patch("app.chaos.random.random", return_value=0.1)
def test_maybe_fail_error(mock_random, monkeypatch):
    monkeypatch.setenv("CHAOS_ENABLED", "true")
    monkeypatch.setenv("CHAOS_CONFIG", json.dumps({"error_rate": 0.2, "status_code": 503}))
    result = chaos.maybe_fail("/api/data")
    assert result is not None
    resp, code = result
    assert code == 503

@patch("app.chaos.random.random", return_value=0.1)
def test_maybe_fail_custom_status(mock_random, monkeypatch):
    monkeypatch.setenv("CHAOS_ENABLED", "true")
    monkeypatch.setenv("CHAOS_CONFIG", json.dumps({"error_rate": 0.2, "status_code": 429}))
    result = chaos.maybe_fail("/api/data")
    assert result is not None
    resp, code = result
    assert code == 429

@patch("app.chaos.random.random", return_value=0.1)
@patch("app.chaos.time.sleep")
def test_maybe_fail_latency(mock_sleep, mock_random, monkeypatch):
    monkeypatch.setenv("CHAOS_ENABLED", "true")
    monkeypatch.setenv("CHAOS_CONFIG", json.dumps({"latency_rate": 0.2, "latency_ms": 2500}))
    result = chaos.maybe_fail("/api/data")
    assert result is None
    mock_sleep.assert_called_once_with(2.5)

@patch("app.chaos.random.random", return_value=0.1)
@patch("app.chaos.time.sleep")
def test_maybe_fail_timeout(mock_sleep, mock_random, monkeypatch):
    monkeypatch.setenv("CHAOS_ENABLED", "true")
    monkeypatch.setenv("CHAOS_CONFIG", json.dumps({"timeout_rate": 0.2}))
    result = chaos.maybe_fail("/api/data")
    assert result is not None
    resp, code = result
    assert code == 504
    mock_sleep.assert_called_once_with(30)

@patch("app.chaos.random.random", return_value=0.9)
def test_maybe_fail_no_fault_when_above_rate(mock_random, monkeypatch):
    monkeypatch.setenv("CHAOS_ENABLED", "true")
    monkeypatch.setenv("CHAOS_CONFIG", json.dumps({"error_rate": 0.5, "latency_rate": 0.5, "timeout_rate": 0.5}))
    result = chaos.maybe_fail("/api/data")
    assert result is None
`;

const DOCKERFILE = `# syntax=docker/dockerfile:1.7
FROM python:3.11-slim
WORKDIR /app
ENV PIP_DISABLE_PIP_VERSION_CHECK=1
ENV OTEL_PROPAGATORS=tracecontext,baggage,b3,b3multi
COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip pip install -r requirements.txt
COPY . .
ENV PORT=5000
EXPOSE 5000
CMD gunicorn --bind "0.0.0.0:$PORT" "app:create_app()"
`;

const DEPENDENCY_CALLER = `import os
import time
import json
import logging
import threading
import random
import uuid
import zlib
import requests
from urllib.parse import urlparse

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("dependency_caller")

_CONFIG_FILE = "/etc/config/dependencies.json"
_dep_config = {"hard": [], "soft": []}
_last_mtime = 0

def _stable_hash(s):
    return zlib.adler32(s.encode('utf-8')) & 0xffffffff

def _load_config():
    global _dep_config, _last_mtime
    # Fallback to env var if file doesn't exist
    if not os.path.exists(_CONFIG_FILE):
        if not _dep_config["hard"]:
            raw = os.environ.get("DEPENDENCY_TARGETS_JSON")
            if raw:
                try:
                    data = json.loads(raw)
                    if isinstance(data, list):
                        _dep_config = {"hard": data, "soft": []}
                    else:
                        _dep_config = data
                except Exception:
                    pass
        return _dep_config

    # Hot-reload if mtime changed
    try:
        mtime = os.path.getmtime(_CONFIG_FILE)
        if mtime > _last_mtime:
            with open(_CONFIG_FILE, "r") as f:
                data = json.load(f)
                if isinstance(data, list):
                    _dep_config = {"hard": data, "soft": []}
                else:
                    _dep_config = data
            _last_mtime = mtime
    except Exception as e:
        logger.error(f"Config load failed: {e}")
    return _dep_config

def _fresh_trace_headers():
    trace_id = uuid.uuid4().hex
    span_id = os.urandom(8).hex()
    return {
        "traceparent": f"00-{trace_id}-{span_id}-01",
        "b3": f"{trace_id}-{span_id}-1",
        "x-b3-traceid": trace_id,
        "x-b3-spanid": span_id,
        "x-b3-sampled": "1",
    }

def run_caller():
    # Only run in container runtimes (not lambda)
    if os.environ.get("AWS_EXECUTION_ENV", "").startswith("AWS_Lambda_"):
        return

    logger.info("Starting dependency caller.")
    # Cache discovered endpoints per target to avoid hammering /discover
    _endpoint_cache = {}
    
    while True:
        # 15-30s interval reduces edge noise while maintaining baseline graph visibility
        time.sleep(random.uniform(15.0, 30.0))
        
        config = _load_config()
        # Background thread calls ONLY hard deps to produce clean DAG edges
        # Soft deps are platform services -- calling them creates star topology noise
        targets = config.get("hard", [])
        
        if not targets:
            continue

        try:
            # Deterministic round-robin based on 120s time window
            window = int(time.time() / 120)
            idx = window % len(targets)
            target = targets[idx].rstrip("/")

            # Try to discover endpoints; cache results for 5 minutes
            cache_entry = _endpoint_cache.get(target)
            if not cache_entry or (time.time() - cache_entry["ts"]) > 300:
                try:
                    disc = requests.get(f"{target}/discover", timeout=2)
                    if disc.ok:
                        data = disc.json()
                        # Handle both old format {"endpoints": [...]} and new {"GET": [...], ...}
                        eps = []
                        if isinstance(data, dict):
                            if "endpoints" in data:
                                eps = [{"method": "GET", "path": p} for p in data["endpoints"]]
                            else:
                                for method, paths in data.items():
                                    for p in paths:
                                        eps.append({"method": method, "path": p})
                        _endpoint_cache[target] = {"eps": eps, "ts": time.time()}
                except Exception:
                    _endpoint_cache[target] = {"eps": [], "ts": time.time()}

            cache_entry = _endpoint_cache.get(target, {})
            eps = cache_entry.get("eps", [])

            if eps:
                # Deterministic endpoint selection within the target
                # Alternate between GET and POST if available
                ep_idx = _stable_hash(str(window) + target) % len(eps)
                ep = eps[ep_idx]
                method = ep["method"]
                path = ep["path"]
                
                parsed = urlparse(target)
                url = f"{parsed.scheme}://{parsed.netloc}{path}"
                
                # Generate fresh W3C traceparent for each background call
                tp_headers = _fresh_trace_headers()
                if method in ("POST", "PUT", "PATCH"):
                    requests.request(method, url, json={}, timeout=5, headers=tp_headers)
                else:
                    requests.get(url, timeout=5, headers=tp_headers)
            else:
                requests.get(f"{target}/health", timeout=5, headers=_fresh_trace_headers())
                
        except Exception as e:
            logger.warning(f"Failed to call dependency: {e}")

def start_dependency_caller():
    t = threading.Thread(target=run_caller, daemon=True)
    t.start()
`;
