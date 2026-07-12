"""Execution runtime shared by every data module.

TWO identities, strictly split (the doctrine of this app): estate reads
(system tables, HMS, Genie, ai_query) run ON-BEHALF-OF the signed-in viewer
via the forwarded token in USER_TOKEN — what a viewer sees is exactly what
their own permissions allow; the app's own service principal is used ONLY
for app-state I/O (data.store), never for estate data.

Owns: the viewer-identity contextvars, the SQL clients, `_run` (Statement
Execution API with full chunk-following — first-chunk-only reads silently
truncate), the short in-process memo, and SQL string-escaping helpers.
"""
from __future__ import annotations

import contextvars
import hashlib
import json
import os
import re
import threading
import time
from functools import lru_cache
from typing import Any


# Per-request forwarded viewer token (Databricks Apps on-behalf-of-user).
# app.py's middleware sets it from X-Forwarded-Access-Token on every request;
# empty when the app has no user_api_scopes or in local runs.
USER_TOKEN: contextvars.ContextVar[str] = contextvars.ContextVar("finops_user_token", default="")

# The signed-in viewer's stable identity (X-Forwarded-Email), set by the same
# middleware. Keys the per-user cache rows so one viewer's cached data is
# never served to another.
USER_ID: contextvars.ContextVar[str] = contextvars.ContextVar("finops_user_id", default="")


def _viewer_principal() -> str:
    """Stable cache-key identity for the current viewer: forwarded email when
    present, else a hash of the forwarded token (colder cache, still never
    cross-viewer)."""
    uid = USER_ID.get()
    if uid:
        return uid
    token = USER_TOKEN.get()
    if token:
        import hashlib

        return "token:" + hashlib.sha256(token.encode()).hexdigest()[:16]
    return "anonymous"


# Hard ceiling on how long we poll a single live query before failing closed.
_MAX_WAIT_SECONDS = 150


# SDK error text can embed the raw request log, including the Authorization
# header — i.e. the forwarded viewer's bearer token. Strip anything JWT-shaped
# before a detail string can reach an API response or the app log.
_TOKEN_RE = re.compile(r"(?:Bearer\s+)?eyJ[A-Za-z0-9._-]{20,}")


def _redact(text: Any) -> str:
    return _TOKEN_RE.sub("<redacted-token>", str(text))


class LiveError(Exception):
    """A live read failed. Carries the system object + a human-readable detail
    so the UI can tell the operator exactly what to grant/fix."""

    def __init__(self, source: str, detail: str):
        self.source = source
        self.detail = _redact(detail)
        super().__init__(f"{self.source}: {self.detail}")


def _client():
    """Workspace client for estate reads — the forwarded viewer token, only.

    Data access follows each viewer's own Unity Catalog permissions
    (on-behalf-of-user); the app's service principal never reads estate data.
    Never cached: forwarded tokens are short-lived and per-viewer.
    Built EXPLICITLY with auth_type="pat": the app container also carries the
    SP's DATABRICKS_CLIENT_ID/SECRET, and the SDK default chain refuses
    ambiguous config ("more than one authorization method").
    """
    token = USER_TOKEN.get()
    if not token:
        raise LiveError(
            "app authorization",
            "no forwarded viewer token on this request — reads run with the "
            "viewer's own permissions (on-behalf-of-user). Open the app "
            "through its Databricks Apps URL and approve the authorization prompt.",
        )
    try:
        from databricks.sdk import WorkspaceClient
    except Exception as e:  # pragma: no cover
        raise LiveError("databricks-sdk", f"SDK not available: {e}")
    return WorkspaceClient(
        host=os.environ.get("DATABRICKS_HOST", ""), token=token, auth_type="pat",
    )


@lru_cache(maxsize=1)
def _app_client():
    """Workspace client as the APP's own identity (SP OAuth env chain in the
    app container). Used ONLY for app-state I/O — never for estate data."""
    try:
        from databricks.sdk import WorkspaceClient
    except Exception as e:  # pragma: no cover
        raise LiveError("databricks-sdk", f"SDK not available: {e}")
    return WorkspaceClient()


def _run(warehouse_id: str, sql: str, source: str, as_app: bool = False) -> list[dict[str, Any]]:
    """Execute one statement and return rows as dicts. Fail-closed.
    as_app=True runs with the APP's credentials (app-state I/O only)."""
    if not warehouse_id:
        raise LiveError("warehouse", "no DATABRICKS_WAREHOUSE_ID configured")
    w = _app_client() if as_app else _client()
    try:
        resp = w.statement_execution.execute_statement(
            warehouse_id=warehouse_id, statement=sql, wait_timeout="30s",
        )
    except Exception as e:
        msg = _redact(e)
        if "Invalid scope" in msg:
            # The viewer's app session predates the app's current permission
            # set, so the forwarded token lacks the `sql` scope. Only the
            # viewer can fix this — by re-authorizing.
            raise LiveError(
                "app authorization",
                "your sign-in to this app predates its data permissions — append "
                "/logout to the app URL, sign back in and approve the prompt, then reload",
            )
        raise LiveError(source, f"query failed to execute: {msg}")

    # Poll to completion. The synchronous window is 30-50s, but estate-wide
    # billing scans on a large account can take longer — poll rather than
    # 503 at the first timeout. Cap so a genuinely stuck query still fails
    # closed (never hangs the request, never fakes data).
    deadline = time.time() + _MAX_WAIT_SECONDS
    while True:
        state_str = getattr(getattr(resp.status, "state", None), "value", str(getattr(resp.status, "state", "")))
        if state_str == "SUCCEEDED":
            break
        if state_str in ("FAILED", "CANCELED", "CLOSED"):
            msg = getattr(getattr(resp.status, "error", None), "message", "") or state_str
            raise LiveError(source, f"query did not succeed ({state_str}): {msg}")
        if time.time() > deadline:
            raise LiveError(source, f"query still running after {_MAX_WAIT_SECONDS}s — the estate is too large for a live scan; enable the caching / roll-up layer")
        time.sleep(3)
        resp = w.statement_execution.get_statement(resp.statement_id)

    manifest = resp.manifest
    result = resp.result
    cols = [c.name for c in manifest.schema.columns] if manifest and manifest.schema else []
    data = list(result.data_array) if result and result.data_array else []
    # Large results arrive in CHUNKS — follow them all, or big reads silently
    # truncate at the first chunk.
    chunk = result
    while chunk is not None and getattr(chunk, "next_chunk_index", None) is not None:
        chunk = w.statement_execution.get_statement_result_chunk_n(
            resp.statement_id, chunk.next_chunk_index)
        if chunk and chunk.data_array:
            data.extend(chunk.data_array)
    return [dict(zip(cols, row)) for row in data]


def _f(v: Any) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


# Short-TTL in-process memo for expensive shared reads. Tabs fire many
# endpoints that re-scan billing/privileges identically. NOTE: entries are
# shared across viewers — fine for this single-operator deployment, but a
# multi-tenant estate with differing viewer permissions would need per-viewer
# keys.
_MEMO: dict[str, tuple[float, Any]] = {}


def _ttl_cache(seconds: int = 600):
    def deco(fn):
        def wrap(*a, **k):
            key = fn.__name__ + repr(a) + repr(sorted(k.items()))
            hit = _MEMO.get(key)
            if hit and time.time() - hit[0] < seconds:
                return hit[1]
            val = fn(*a, **k)
            _MEMO[key] = (time.time(), val)
            return val
        wrap.__name__ = fn.__name__
        return wrap
    return deco


def _sql_str(v: Any) -> str:
    return str(v or "").replace("\\", "\\\\").replace("'", "''")


def _sql_num(v: Any) -> str:
    try:
        return str(int(float(v)))
    except (TypeError, ValueError):
        return "0"
