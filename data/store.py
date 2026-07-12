"""The app-state STORE — the only place the app ever writes.

Two backends picked by the deploy-time `app_store` setting: lakebase
(default; bundle-created Postgres, app connects as its own SP, own `finops`
schema) or uc (Delta tables written with app credentials). Also home to the
operator settings persisted there: the workspace scope and the tag
exclusions. Estate data NEVER lives here, and store I/O never uses the
viewer token.
"""
from __future__ import annotations

import os
import re
import threading
import time
from typing import Any
from data.runtime import LiveError, _app_client, _redact, _run, _sql_str, _ttl_cache


# ---------------------------------------------------------------------------
# App-state store — where the app keeps ITS OWN tables (workspace scope,
# workspace universe, query-advisor cache). Two backends, picked by the
# deploy-time ``app_store`` parameter:
#   * lakebase (default) — a Lakebase Postgres database created by the
#     bundle; the app connects as its own SP (OAuth token as the Postgres
#     password). NOTHING is created in Unity Catalog.
#   * uc — Delta tables in app_catalog.app_schema, written with the app's
#     credentials (as_app statements) — never the viewer's.
# Estate data NEVER lives here, and store I/O never uses the viewer token.
# ---------------------------------------------------------------------------
_IDENT_RE = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_-]{0,254}$")


def _store_is_lakebase() -> bool:
    from data.config import get_settings

    return str(get_settings().get("app_store") or "lakebase").lower() != "uc"


# One cached Postgres connection, serialised by a lock (app-state ops are
# quick). The SP OAuth token used as the password expires, so the connection
# is rebuilt before the hour is up — and dropped on any error.
_PG_LOCK = threading.Lock()
_PG: dict[str, Any] = {"conn": None, "expires": 0.0}
_PG_READY = False


def _pg_connect():
    import uuid

    try:
        import psycopg
    except Exception as e:  # pragma: no cover
        raise LiveError("lakebase", f"psycopg not installed: {e}")
    from data.config import get_settings

    s = get_settings()
    instance = str(s.get("lakebase_instance") or "")
    dbname = str(s.get("lakebase_database") or "databricks_postgres")
    if not instance:
        raise LiveError("lakebase", "no FINOPS_LAKEBASE_INSTANCE configured")
    user = os.environ.get("DATABRICKS_CLIENT_ID", "")
    if not user:
        raise LiveError("lakebase", "no app service principal in the environment "
                                    "(DATABRICKS_CLIENT_ID) — Lakebase runs with app credentials")
    try:
        w = _app_client()
        inst = w.database.get_database_instance(name=instance)
        cred = w.database.generate_database_credential(
            request_id=str(uuid.uuid4()), instance_names=[instance])
        conn = psycopg.connect(
            host=inst.read_write_dns, port=5432, dbname=dbname, user=user,
            password=cred.token, sslmode="require", autocommit=True,
            connect_timeout=15)
        # The app's role can CREATE on the database but not in `public` —
        # keep everything in the app's own schema.
        with conn.cursor() as cur:
            cur.execute("CREATE SCHEMA IF NOT EXISTS finops")
            cur.execute("SET search_path TO finops")
        return conn
    except LiveError:
        raise
    except Exception as e:
        raise LiveError("lakebase", f"cannot connect to instance '{instance}': {_redact(e)}")


def _pg_exec(sql: str, params: Any = None, many: bool = False,
             fetch: bool = False, source: str = "lakebase") -> list[dict[str, Any]]:
    """Run one statement on the app's Lakebase database (as the APP)."""
    with _PG_LOCK:
        conn = _PG["conn"]
        if conn is None or getattr(conn, "closed", True) or time.time() > _PG["expires"]:
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass
            conn = _pg_connect()
            _PG["conn"], _PG["expires"] = conn, time.time() + 50 * 60
        try:
            with conn.cursor() as cur:
                if many:
                    cur.executemany(sql, params or [])
                else:
                    cur.execute(sql, params)
                if fetch and cur.description:
                    from decimal import Decimal

                    cols = [d.name for d in cur.description]
                    # Postgres numerics arrive as Decimal — normalise to float
                    # so payloads stay JSON-serialisable.
                    return [
                        {c: (float(v) if isinstance(v, Decimal) else v)
                         for c, v in zip(cols, row)}
                        for row in cur.fetchall()
                    ]
                return []
        except Exception as e:
            _PG["conn"] = None  # drop the (possibly broken) connection
            raise LiveError(source, _redact(e))


def _pg_ensure() -> None:
    """Create the app-state tables once per process (idempotent DDL)."""
    global _PG_READY
    if _PG_READY:
        return
    _pg_exec("CREATE TABLE IF NOT EXISTS workspace_scope (workspace_id text PRIMARY KEY)")
    _pg_exec("CREATE TABLE IF NOT EXISTS tag_exclusions (tag_key text PRIMARY KEY)")
    _pg_exec("CREATE TABLE IF NOT EXISTS app_identity_map (integration_id text PRIMARY KEY, app_name text)")
    _pg_exec("""CREATE TABLE IF NOT EXISTS workspace_universe (
                  workspace_id text PRIMARY KEY, spend_usd_month double precision,
                  dbus_month double precision, computed_at timestamptz)""")
    _pg_exec("""CREATE TABLE IF NOT EXISTS qa_executions (
                  statement_id text PRIMARY KEY, fingerprint text, statement_type text,
                  workspace_id text, warehouse_id text, executed_by text,
                  start_time timestamptz, duration_ms bigint, task_ms bigint,
                  read_bytes bigint, pruned_files_bytes bigint, read_files_bytes bigint,
                  spilled_local_bytes bigint, waiting_at_capacity_ms bigint,
                  statement_text text,
                  exec_ms bigint DEFAULT 0, compile_ms bigint DEFAULT 0,
                  compute_wait_ms bigint DEFAULT 0, fetch_ms bigint DEFAULT 0,
                  read_rows bigint DEFAULT 0, produced_rows bigint DEFAULT 0,
                  from_cache bigint DEFAULT 0, client_app text DEFAULT '',
                  source_label text DEFAULT '')""")
    # Time-breakdown migration for stores created before these columns
    # existed (old rows read as 0/'' and age out with retention).
    for col, typ in (("exec_ms", "bigint DEFAULT 0"), ("compile_ms", "bigint DEFAULT 0"),
                     ("compute_wait_ms", "bigint DEFAULT 0"), ("fetch_ms", "bigint DEFAULT 0"),
                     ("read_rows", "bigint DEFAULT 0"), ("produced_rows", "bigint DEFAULT 0"),
                     ("from_cache", "bigint DEFAULT 0"), ("client_app", "text DEFAULT ''"),
                     ("source_label", "text DEFAULT ''")):
        _pg_exec(f"ALTER TABLE qa_executions ADD COLUMN IF NOT EXISTS {col} {typ}")
    _pg_exec("CREATE INDEX IF NOT EXISTS qa_exec_start_idx ON qa_executions (start_time)")
    _pg_exec("""CREATE TABLE IF NOT EXISTS qa_analysis (
                  fingerprint text PRIMARY KEY, ai_advice text, ai_model text,
                  analyzed_at timestamptz)""")
    _pg_exec("""CREATE TABLE IF NOT EXISTS app_cache (
                  object_id text, principal text NOT NULL DEFAULT 'shared',
                  payload text, computed_at text, refresh_started_at text,
                  error text, build text)""")
    _pg_exec("ALTER TABLE app_cache ADD COLUMN IF NOT EXISTS build text")
    # Migration from the pre-principal shape: add the column, drop the old
    # single-column primary key, enforce uniqueness on (object, principal).
    _pg_exec("ALTER TABLE app_cache ADD COLUMN IF NOT EXISTS principal text NOT NULL DEFAULT 'shared'")
    _pg_exec("ALTER TABLE app_cache DROP CONSTRAINT IF EXISTS app_cache_pkey")
    _pg_exec("CREATE UNIQUE INDEX IF NOT EXISTS app_cache_key ON app_cache (object_id, principal)")
    _PG_READY = True


def _app_schema() -> tuple[str, str]:
    """(catalog, schema) for the app's own objects, charset-validated because
    the identifiers are inlined into SQL."""
    from data.config import get_settings

    settings = get_settings()
    cat, sch = str(settings["app_catalog"]), str(settings["app_schema"])
    for ident in (cat, sch):
        if not _IDENT_RE.match(ident):
            raise LiveError("app schema", f"invalid app_catalog/app_schema identifier: {ident!r}")
    return cat, sch


def _schema_fqn() -> str:
    cat, sch = _app_schema()
    return f"`{cat}`.`{sch}`"


def _scope_table_fqn() -> str:
    return f"{_schema_fqn()}.workspace_scope"


@_ttl_cache(60)
def workspace_scope(warehouse_id: str):
    """The operator's included-workspace set (Configuration page); None = no filter.
    A missing/unreadable table means no filter — the app must not go dark
    just because scoping was never configured. Read as the APP."""
    try:
        if _store_is_lakebase():
            _pg_ensure()
            rows = _pg_exec("SELECT workspace_id FROM workspace_scope",
                            fetch=True, source="workspace_scope")
        else:
            rows = _run(warehouse_id, f"SELECT workspace_id FROM {_scope_table_fqn()}",
                        "workspace_scope", as_app=True)
    except LiveError:
        return None
    ids = frozenset(str(r.get("workspace_id") or "") for r in rows) - {""}
    return ids or None


def _ws_scope_sql(warehouse_id: str, col: str = "u.workspace_id") -> str:
    """SQL predicate applying the operator scope; empty when no scope is set.
    IDs are digit-validated on write, so inlining them is safe."""
    ids = workspace_scope(warehouse_id)
    if not ids:
        return ""
    idlist = ",".join(f"'{i}'" for i in sorted(ids))
    return f" AND {col} IN ({idlist})"


def set_workspace_scope(warehouse_id: str, ids: list[str]) -> None:
    """Overwrite the included-workspace set; an empty list clears the filter.
    Written as the APP. Invalidates every in-process memo AND the advisor
    execution store — their contents are scope-dependent (qa_analysis is
    kept: AI advice is keyed by query text, scope-free)."""
    # Late imports: cache/advisor import this module — top-level would cycle.
    from data.cache import cache_clear_all
    from data.runtime import _MEMO
    from data.advisor import _qa_exec_fqn
    for i in ids:
        if not re.fullmatch(r"[0-9]{1,20}", i):
            raise LiveError("workspace_scope", f"invalid workspace id: {i!r}")
    uniq = sorted(set(ids))
    if _store_is_lakebase():
        _pg_ensure()
        _pg_exec("TRUNCATE TABLE workspace_scope", source="workspace_scope")
        if uniq:
            _pg_exec("INSERT INTO workspace_scope (workspace_id) VALUES (%s)",
                     [(i,) for i in uniq], many=True, source="workspace_scope")
        _pg_exec("TRUNCATE TABLE qa_executions", source="qa_executions (scope change)")
    else:
        _run(warehouse_id, f"CREATE SCHEMA IF NOT EXISTS {_schema_fqn()}", "app schema", as_app=True)
        table = _scope_table_fqn()
        if uniq:
            values = ",".join(f"('{i}')" for i in uniq)
            _run(warehouse_id,
                 f"CREATE OR REPLACE TABLE {table} AS SELECT * FROM VALUES {values} AS t(workspace_id)",
                 "workspace_scope", as_app=True)
        else:
            # Empty table = no filter. Kept (not dropped) so the object stays stable.
            _run(warehouse_id, f"CREATE OR REPLACE TABLE {table} (workspace_id STRING)",
                 "workspace_scope", as_app=True)
        try:
            _run(warehouse_id, f"TRUNCATE TABLE {_qa_exec_fqn()}",
                 "qa_executions (scope change)", as_app=True)
        except LiveError:
            pass  # store not created yet — the next advisor load backfills it
    cache_clear_all(warehouse_id)
    _MEMO.clear()


# ---------------------------------------------------------------------------
# Tag exclusions — operator-picked BLANKET tag keys (workspace defaults like
# an auto-applied Owner tag, platform-injected keys like ServingType) that
# must not count toward tagging coverage. Applied consistently to every
# tagging metric: Tags coverage, the Governance tile, the per-workspace
# tagging check and the hub's untagged figure. Stored by the app, like the
# workspace scope.
# ---------------------------------------------------------------------------
def _exclusions_table_fqn() -> str:
    return f"{_schema_fqn()}.tag_exclusions"


@_ttl_cache(60)
def tag_exclusions(warehouse_id: str) -> list[str]:
    """The excluded tag keys; empty when never configured or unreadable —
    coverage must not go dark because the setting is absent. Read as the APP."""
    try:
        if _store_is_lakebase():
            _pg_ensure()
            rows = _pg_exec("SELECT tag_key FROM tag_exclusions",
                            fetch=True, source="tag_exclusions")
        else:
            rows = _run(warehouse_id, f"SELECT tag_key FROM {_exclusions_table_fqn()}",
                        "tag_exclusions", as_app=True)
    except LiveError:
        return []
    return sorted({str(r.get("tag_key") or "") for r in rows} - {""})


def set_tag_exclusions(warehouse_id: str, keys: list[str]) -> list[str]:
    """Overwrite the excluded-key set (as the APP). Clears every cached
    object + memo — the exclusion changes tagging math on several tabs."""
    # Late imports: cache imports this module — top-level would cycle.
    from data.cache import cache_clear_all
    from data.runtime import _MEMO
    uniq = sorted({str(k).strip() for k in keys if str(k).strip()})
    for k in uniq:
        if len(k) > 255:
            raise LiveError("tag_exclusions", f"tag key too long: {k[:40]!r}…")
    if len(uniq) > 100:
        raise LiveError("tag_exclusions", "too many excluded keys (max 100)")
    if _store_is_lakebase():
        _pg_ensure()
        _pg_exec("TRUNCATE TABLE tag_exclusions", source="tag_exclusions")
        if uniq:
            _pg_exec("INSERT INTO tag_exclusions (tag_key) VALUES (%s)",
                     [(k,) for k in uniq], many=True, source="tag_exclusions")
    else:
        _run(warehouse_id, f"CREATE SCHEMA IF NOT EXISTS {_schema_fqn()}", "app schema", as_app=True)
        table = _exclusions_table_fqn()
        if uniq:
            values = ",".join(f"('{_sql_str(k)}')" for k in uniq)
            _run(warehouse_id,
                 f"CREATE OR REPLACE TABLE {table} AS SELECT * FROM VALUES {values} AS t(tag_key)",
                 "tag_exclusions", as_app=True)
        else:
            _run(warehouse_id, f"CREATE OR REPLACE TABLE {table} (tag_key STRING)",
                 "tag_exclusions", as_app=True)
    cache_clear_all(warehouse_id)
    _MEMO.clear()
    return uniq


# ---------------------------------------------------------------------------
# App identity labels — operator-assigned names for OAuth app integrations.
# The Apps $ OBO attribution groups by integration id (from audit
# acting_resource); names come from the integration's creation audit event
# when retention still covers it, and from these labels otherwise.
# ---------------------------------------------------------------------------
_INTEGRATION_ID_RE = re.compile(r"[0-9a-fA-F-]{8,64}$")


def _identity_map_fqn() -> str:
    return f"{_schema_fqn()}.app_identity_map"


@_ttl_cache(60)
def app_identity_labels(warehouse_id: str) -> dict[str, str]:
    """Operator labels {integration_id: app name}; empty when never set or
    unreadable — attribution then falls back to audit auto-names / raw ids.
    Read as the APP."""
    try:
        if _store_is_lakebase():
            _pg_ensure()
            rows = _pg_exec("SELECT integration_id, app_name FROM app_identity_map",
                            fetch=True, source="app_identity_map")
        else:
            rows = _run(warehouse_id,
                        f"SELECT integration_id, app_name FROM {_identity_map_fqn()}",
                        "app_identity_map", as_app=True)
    except LiveError:
        return {}
    return {str(r.get("integration_id") or ""): str(r.get("app_name") or "")
            for r in rows if r.get("integration_id") and r.get("app_name")}


def set_app_identity_label(warehouse_id: str, integration_id: str, name: str) -> dict[str, str]:
    """Upsert one label (empty name deletes it), as the APP. Only the Apps $
    cache object depends on this — the UI refreshes it after saving."""
    from data.cache import _purge_memo

    iid = str(integration_id).strip()
    label = str(name).strip()[:200]
    if not _INTEGRATION_ID_RE.fullmatch(iid):
        raise LiveError("app_identity_map", f"invalid integration id: {iid!r}")
    if _store_is_lakebase():
        _pg_ensure()
        if label:
            _pg_exec("INSERT INTO app_identity_map (integration_id, app_name) VALUES (%s, %s) "
                     "ON CONFLICT (integration_id) DO UPDATE SET app_name = EXCLUDED.app_name",
                     [(iid, label)], many=True, source="app_identity_map")
        else:
            _pg_exec("DELETE FROM app_identity_map WHERE integration_id = %s",
                     [(iid,)], many=True, source="app_identity_map")
    else:
        _run(warehouse_id, f"CREATE SCHEMA IF NOT EXISTS {_schema_fqn()}", "app schema", as_app=True)
        _run(warehouse_id, f"CREATE TABLE IF NOT EXISTS {_identity_map_fqn()} "
                           "(integration_id STRING, app_name STRING)",
             "app_identity_map", as_app=True)
        if label:
            _run(warehouse_id, f"""
                MERGE INTO {_identity_map_fqn()} t
                USING (SELECT '{_sql_str(iid)}' AS integration_id, '{_sql_str(label)}' AS app_name) s
                ON t.integration_id = s.integration_id
                WHEN MATCHED THEN UPDATE SET t.app_name = s.app_name
                WHEN NOT MATCHED THEN INSERT *""", "app_identity_map", as_app=True)
        else:
            _run(warehouse_id,
                 f"DELETE FROM {_identity_map_fqn()} WHERE integration_id = '{_sql_str(iid)}'",
                 "app_identity_map", as_app=True)
    _purge_memo("app_identity_labels")
    return app_identity_labels(warehouse_id)


def _untagged_pred(warehouse_id: str, col: str) -> str:
    """SQL predicate: this usage row counts as UNTAGGED — no tags at all, or
    nothing left once the operator-excluded blanket keys are removed."""
    excl = tag_exclusions(warehouse_id)
    if not excl:
        return f"({col} IS NULL OR cardinality(map_keys({col})) = 0)"
    arr = ", ".join(f"'{_sql_str(k)}'" for k in excl)
    return (f"({col} IS NULL OR size(array_except(map_keys({col}), array({arr}))) <= 0)")
