"""The 24-hour object cache behind every page.

Each expensive page payload is a registered CACHE OBJECT persisted in the
app store, keyed (object_id, principal): loaders that read estate data
on-behalf-of-user cache one row PER VIEWER, so permissions are never shared
across people. Rows carry a build stamp (content hash of this package);
stale objects keep serving while a background refresh — carrying the
requesting viewer's token — rebuilds them. The registry dict lives here but
is populated by data.live (the facade).
"""
from __future__ import annotations

import hashlib
import json
import pathlib
import threading
import time
from typing import Any
from data.runtime import LiveError, USER_ID, USER_TOKEN, _MEMO, _redact, _run, _sql_str, _viewer_principal
from data.store import _pg_ensure, _pg_exec, _schema_fqn, _store_is_lakebase


# ---------------------------------------------------------------------------
# 24-hour object cache. Every expensive page payload is a registered CACHE
# OBJECT, persisted in the app store (so it survives restarts) and listed on
# the Configuration page grouped by tab. Serving reads the stored payload; a stale
# object (age > TTL) is served AS-IS while a background refresh — running
# with the requesting viewer's token — rebuilds it. Explicit refresh buttons
# (Admin + each page) call refresh_object().
# ---------------------------------------------------------------------------
CACHE_TTL_SECONDS = 24 * 3600
_REFRESH_STUCK_SECONDS = 20 * 60  # a "refreshing" row older than this is dead

# Payload SHAPES change across deploys — a cached row written by different
# code is treated as absent rather than served into a frontend that expects
# new fields. The stamp changes whenever this file is redeployed.
# Build stamp on every cache row: payloads written by a DIFFERENT build of
# the data package are treated as absent (shapes may have changed). Hash of
# EVERY module in the package — a deploy that doesn't change data code
# keeps every viewer's cache warm.
_stamp = hashlib.md5()
for _mod in sorted(pathlib.Path(__file__).parent.glob("*.py")):
    _stamp.update(_mod.read_bytes())
_CODE_STAMP = _stamp.hexdigest()[:16]

_CACHE_LOCKS: dict[str, threading.Lock] = {}
_CACHE_LOCKS_GUARD = threading.Lock()


def _cache_lock(object_id: str, principal: str) -> threading.Lock:
    with _CACHE_LOCKS_GUARD:
        return _CACHE_LOCKS.setdefault(f"{object_id}|{principal}", threading.Lock())


def _object_scope(object_id: str) -> str:
    """"user" — the loader reads estate data on-behalf-of-user, so each viewer
    gets their own cache row (permissions preserved). "shared" — the loader
    runs with the app's own credentials, so one row serves everyone."""
    return str(_CACHE_REGISTRY[object_id].get("scope") or "user")


def _object_principal(object_id: str) -> str:
    return "shared" if _object_scope(object_id) == "shared" else _viewer_principal()


def _purge_memo(prefix: str) -> None:
    for k in [k for k in _MEMO if k.startswith(prefix)]:
        _MEMO.pop(k, None)


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _iso_age_seconds(iso: str | None) -> int | None:
    if not iso:
        return None
    try:
        return max(0, int(time.time() - time.mktime(time.strptime(str(iso)[:19], "%Y-%m-%dT%H:%M:%S"))))
    except ValueError:
        return None


def _cache_table_fqn() -> str:
    return f"{_schema_fqn()}.app_cache"


_UC_CACHE_READY = False


def _uc_cache_ensure(warehouse_id: str) -> None:
    """Idempotent DDL, once per process (mirrors _pg_ensure/_PG_READY) —
    unguarded, every cache read/write/mark paid 3 extra warehouse
    statements per call."""
    global _UC_CACHE_READY
    if _UC_CACHE_READY:
        return
    _run(warehouse_id, f"CREATE SCHEMA IF NOT EXISTS {_schema_fqn()}", "app schema", as_app=True)
    _run(warehouse_id, f"""
        CREATE TABLE IF NOT EXISTS {_cache_table_fqn()} (
          object_id STRING, principal STRING, payload STRING, computed_at STRING,
          refresh_started_at STRING, error STRING, build STRING)""", "app_cache", as_app=True)
    try:  # migrate a pre-principal table (column add is idempotent-by-failure)
        _run(warehouse_id, f"ALTER TABLE {_cache_table_fqn()} ADD COLUMNS (principal STRING)",
             "app_cache", as_app=True)
    except LiveError:
        pass
    _UC_CACHE_READY = True


def _cache_rows(warehouse_id: str, principals: tuple[str, ...]) -> dict[tuple[str, str], dict[str, Any]]:
    """Cache rows (metadata + payload) for the given principals, keyed by
    (object_id, principal); {} when the table does not exist yet. Rows written
    by a different code version are stripped to empty (their payload shape may
    no longer match)."""
    try:
        if _store_is_lakebase():
            _pg_ensure()
            rows = _pg_exec("SELECT object_id, principal, payload, computed_at, refresh_started_at, error, build "
                            "FROM app_cache WHERE principal = ANY(%s)",
                            (list(principals),), fetch=True, source="app_cache")
        else:
            _uc_cache_ensure(warehouse_id)
            plist = ",".join(f"'{_sql_str(p)}'" for p in principals)
            rows = _run(warehouse_id,
                        f"SELECT object_id, principal, payload, computed_at, refresh_started_at, error, build "
                        f"FROM {_cache_table_fqn()} WHERE principal IN ({plist})", "app_cache", as_app=True)
    except LiveError:
        return {}
    out: dict[tuple[str, str], dict[str, Any]] = {}
    for r in rows:
        if str(r.get("build") or "") != _CODE_STAMP:
            r = {**r, "payload": None, "computed_at": None, "error": None}
        out[(str(r.get("object_id")), str(r.get("principal")))] = r
    return out


def _cache_row(warehouse_id: str, object_id: str, principal: str) -> dict[str, Any] | None:
    return _cache_rows(warehouse_id, (principal,)).get((object_id, principal))


def _json_default(o: Any) -> Any:
    from decimal import Decimal

    if isinstance(o, Decimal):
        return float(o)
    return str(o)


def _cache_write(warehouse_id: str, object_id: str, principal: str, payload_json: str) -> None:
    now = _now_iso()
    if _store_is_lakebase():
        _pg_ensure()
        _pg_exec("INSERT INTO app_cache (object_id, principal, payload, computed_at, refresh_started_at, error, build) "
                 "VALUES (%s, %s, %s, %s, NULL, NULL, %s) "
                 "ON CONFLICT (object_id, principal) DO UPDATE SET payload = EXCLUDED.payload, "
                 "computed_at = EXCLUDED.computed_at, refresh_started_at = NULL, error = NULL, "
                 "build = EXCLUDED.build",
                 (object_id, principal, payload_json, now, _CODE_STAMP), source="app_cache")
    else:
        _uc_cache_ensure(warehouse_id)
        _run(warehouse_id, f"""
            MERGE INTO {_cache_table_fqn()} t
            USING (SELECT '{_sql_str(object_id)}' AS object_id, '{_sql_str(principal)}' AS principal,
                          '{_sql_str(payload_json)}' AS payload, '{now}' AS computed_at,
                          '{_CODE_STAMP}' AS build) s
            ON t.object_id = s.object_id AND COALESCE(t.principal, 'shared') = s.principal
            WHEN MATCHED THEN UPDATE SET payload = s.payload, computed_at = s.computed_at,
                                         refresh_started_at = NULL, error = NULL, build = s.build,
                                         principal = s.principal
            WHEN NOT MATCHED THEN INSERT (object_id, principal, payload, computed_at, refresh_started_at, error, build)
            VALUES (s.object_id, s.principal, s.payload, s.computed_at, NULL, NULL, s.build)""",
             "app_cache", as_app=True)


def _cache_mark(warehouse_id: str, object_id: str, principal: str,
                refreshing: bool, error: str | None = None) -> None:
    ts = _now_iso() if refreshing else None
    if _store_is_lakebase():
        _pg_ensure()
        _pg_exec("INSERT INTO app_cache (object_id, principal, payload, computed_at, refresh_started_at, error, build) "
                 "VALUES (%s, %s, NULL, NULL, %s, %s, NULL) "
                 "ON CONFLICT (object_id, principal) DO UPDATE SET refresh_started_at = EXCLUDED.refresh_started_at, "
                 "error = EXCLUDED.error",
                 (object_id, principal, ts, error), source="app_cache")
    else:
        _uc_cache_ensure(warehouse_id)
        ts_sql = f"'{ts}'" if ts else "NULL"
        err_sql = f"'{_sql_str(error)}'" if error else "NULL"
        _run(warehouse_id, f"""
            MERGE INTO {_cache_table_fqn()} t
            USING (SELECT '{_sql_str(object_id)}' AS object_id, '{_sql_str(principal)}' AS principal) s
            ON t.object_id = s.object_id AND COALESCE(t.principal, 'shared') = s.principal
            WHEN MATCHED THEN UPDATE SET refresh_started_at = {ts_sql}, error = {err_sql}
            WHEN NOT MATCHED THEN INSERT (object_id, principal, payload, computed_at, refresh_started_at, error, build)
            VALUES (s.object_id, s.principal, NULL, NULL, {ts_sql}, {err_sql}, NULL)""",
             "app_cache", as_app=True)


def cache_clear_all(warehouse_id: str) -> None:
    """Drop every cached object (scope changes invalidate everything)."""
    try:
        if _store_is_lakebase():
            _pg_ensure()
            _pg_exec("TRUNCATE TABLE app_cache", source="app_cache")
        else:
            _run(warehouse_id, f"DELETE FROM {_cache_table_fqn()}", "app_cache", as_app=True)
    except LiveError:
        pass  # cache table not created yet


def _row_refreshing(row: dict[str, Any] | None) -> bool:
    if not row or not row.get("refresh_started_at"):
        return False
    age = _iso_age_seconds(str(row.get("refresh_started_at")))
    return age is not None and age < _REFRESH_STUCK_SECONDS


def _cache_meta(object_id: str, row: dict[str, Any] | None) -> dict[str, Any]:
    return {
        "object": object_id,
        "computed_at": (str(row.get("computed_at")) if row and row.get("computed_at") else None),
        "age_seconds": _iso_age_seconds(row.get("computed_at") if row else None),
        "ttl_seconds": CACHE_TTL_SECONDS,
        "refreshing": _row_refreshing(row),
        "error": (str(row.get("error")) if row and row.get("error") else None),
    }


def _spawn_refresh(object_id: str, principal: str, warehouse_id: str) -> bool:
    """Fire a background rebuild of one object with the CURRENT viewer's
    token + identity (per-user objects rebuild THAT viewer's row). Returns
    False when a refresh is already running (in-process lock) or no viewer
    token is available to read the estate with."""
    token = USER_TOKEN.get()
    uid = USER_ID.get()
    if not token:
        return False
    lock = _cache_lock(object_id, principal)
    if not lock.acquire(blocking=False):
        return False
    _cache_mark(warehouse_id, object_id, principal, refreshing=True)

    def _work() -> None:
        USER_TOKEN.set(token)
        USER_ID.set(uid)
        try:
            payload = _CACHE_REGISTRY[object_id]["loader"](warehouse_id)
            _cache_write(warehouse_id, object_id, principal, json.dumps(payload, default=_json_default))
        except LiveError as e:
            _cache_mark(warehouse_id, object_id, principal, refreshing=False, error=e.detail)
        except Exception as e:  # noqa: BLE001 — a failed refresh must never wedge the flag
            _cache_mark(warehouse_id, object_id, principal, refreshing=False, error=_redact(e))
        finally:
            lock.release()

    threading.Thread(target=_work, daemon=True, name=f"cache-{object_id}").start()
    return True


def cached(object_id: str, warehouse_id: str) -> tuple[Any, dict[str, Any]]:
    """Serve one registered object for the CURRENT principal: per-user objects
    (loaders that read on-behalf-of-user) key on the viewer, shared objects
    (app-credential loaders) on 'shared'. Stored payload is served as-is,
    kicking off a background refresh when past TTL; the very first request
    computes synchronously."""
    spec = _CACHE_REGISTRY[object_id]
    principal = _object_principal(object_id)
    row = _cache_row(warehouse_id, object_id, principal)
    if row and row.get("payload"):
        meta = _cache_meta(object_id, row)
        if (meta["age_seconds"] or 0) > CACHE_TTL_SECONDS and not meta["refreshing"]:
            if _spawn_refresh(object_id, principal, warehouse_id):
                meta["refreshing"] = True
        return json.loads(str(row["payload"])), meta
    # First-ever request for this principal: compute synchronously under the
    # object lock so parallel first requests don't duplicate the work.
    lock = _cache_lock(object_id, principal)
    with lock:
        row = _cache_row(warehouse_id, object_id, principal)
        if row and row.get("payload"):
            return json.loads(str(row["payload"])), _cache_meta(object_id, row)
        _cache_mark(warehouse_id, object_id, principal, refreshing=True)
        try:
            payload = spec["loader"](warehouse_id)
            _cache_write(warehouse_id, object_id, principal, json.dumps(payload, default=_json_default))
        except LiveError as e:
            _cache_mark(warehouse_id, object_id, principal, refreshing=False, error=e.detail)
            raise
        return payload, _cache_meta(object_id, _cache_row(warehouse_id, object_id, principal))


def _cached_payload(object_id: str, warehouse_id: str) -> Any:
    return cached(object_id, warehouse_id)[0]


def refresh_object(object_id: str, warehouse_id: str) -> dict[str, Any]:
    """Explicit refresh (Admin / page buttons): spawn a background rebuild of
    the current principal's row unless one is already running; returns the
    object's current meta."""
    if object_id not in _CACHE_REGISTRY:
        raise LiveError("app cache", f"unknown cache object: {object_id!r}")
    principal = _object_principal(object_id)
    row = _cache_row(warehouse_id, object_id, principal)
    if not _row_refreshing(row):
        _spawn_refresh(object_id, principal, warehouse_id)
        row = _cache_row(warehouse_id, object_id, principal)
    return _cache_meta(object_id, row)


def cache_status(warehouse_id: str) -> list[dict[str, Any]]:
    """Every registered object with its tab, what it queries, its cache scope
    (per user vs shared) and freshness — the Configuration page's cached-data listing.
    Per-user objects show the CURRENT viewer's row."""
    viewer = _viewer_principal()
    rows = _cache_rows(warehouse_id, (viewer, "shared"))
    out = []
    for oid, spec in _CACHE_REGISTRY.items():
        principal = "shared" if _object_scope(oid) == "shared" else viewer
        out.append({
            "label": spec["label"], "tab": spec["tab"], "queries": spec["queries"],
            "scope": _object_scope(oid),
            **_cache_meta(oid, rows.get((oid, principal))),
        })
    return out


# The registry of cache objects — POPULATED BY data.live (the facade) at
# import time, so feature modules stay import-light and cycle-free.
_CACHE_REGISTRY: dict[str, dict[str, Any]] = {}
