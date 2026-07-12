"""Query Advisor: an incremental mirror of system.query.history in the app
store (SELECT statements only, text-fingerprinted, wall-time phase
breakdown per execution), fingerprint rollups for the 24h/7d windows kept
by TOTAL task time (the compute burden cost allocation follows), and
ai_query reviews — one per fingerprint, run AS THE VIEWER, on demand or in
a background batch.
"""
from __future__ import annotations

import json
import os
import threading
from typing import Any
from data.cache import _cache_write, _cached_payload, _json_default
from data.runtime import LiveError, USER_ID, USER_TOKEN, _f, _run, _sql_num, _sql_str, _viewer_principal
from data.store import _app_schema, _pg_ensure, _pg_exec, _schema_fqn, _store_is_lakebase, _ws_scope_sql


# ---------------------------------------------------------------------------
# Queries / tables / access / governance / detail / hub.
# Physical table detail (DESCRIBE DETAIL) is NOT collected yet, so table
# metrics that would require it are zeroed and labelled — never invented.
# ---------------------------------------------------------------------------

# The rollups exist for exactly these two windows — sub-day chips would
# silently serve 24h data under a 1h/6h label, so the UI offers only these.
_QUERY_DAYS = {"24h": 1, "7d": 7}
# The UI's widest window is 7d — mirror 8 days (one spare for late arrivals).
_QA_LOOKBACK_DAYS = 8
_AI_BATCH = 15
_AI_LOCK = threading.Lock()


def _qa_exec_fqn() -> str:
    return f"{_schema_fqn()}.qa_executions"


def _qa_analysis_fqn() -> str:
    return f"{_schema_fqn()}.qa_analysis"


def _qa_scope_sql(warehouse_id: str) -> str:
    """Ingest-time filters: operator workspace scope (or the app's own
    workspace) + never our own plumbing or system-table scans."""
    wsf = _ws_scope_sql(warehouse_id, "q.workspace_id")
    if not wsf:
        own = os.environ.get("DATABRICKS_WORKSPACE_ID", "")
        wsf = f" AND q.workspace_id = '{own}'" if own else ""
    try:
        _, own_schema = _app_schema()
    except LiveError:
        own_schema = "finops_cache"
    wsf += (" AND NOT (q.statement_text ILIKE '%system.billing%'"
            " OR q.statement_text ILIKE '%system.query%'"
            " OR q.statement_text ILIKE '%system.information_schema%'"
            " OR q.statement_text ILIKE '%system.access%'"
            f" OR q.statement_text ILIKE '%{own_schema}%')")
    return wsf


# Columns mirrored from system.query.history, in ingest order. The last nine
# power the wall-time breakdown (where a slow run's time actually went) and
# the issuing-source attribution.
_QA_COLS = ("statement_id", "fingerprint", "statement_type", "workspace_id",
            "warehouse_id", "executed_by", "start_time", "duration_ms",
            "task_ms", "read_bytes", "pruned_files_bytes", "read_files_bytes",
            "spilled_local_bytes", "waiting_at_capacity_ms", "statement_text",
            "exec_ms", "compile_ms", "compute_wait_ms", "fetch_ms",
            "read_rows", "produced_rows", "from_cache", "client_app",
            "source_label")
_QA_FETCH_LIMIT = 10000  # per ingest cycle; the first backfill catches up across cycles


def _qa_ensure(warehouse_id: str) -> None:
    if _store_is_lakebase():
        _pg_ensure()
        return
    _run(warehouse_id, f"CREATE SCHEMA IF NOT EXISTS {_schema_fqn()}", "app schema", as_app=True)
    _run(warehouse_id, f"""
        CREATE TABLE IF NOT EXISTS {_qa_exec_fqn()} (
          statement_id STRING, fingerprint STRING, statement_type STRING,
          workspace_id STRING, warehouse_id STRING, executed_by STRING,
          start_time TIMESTAMP, duration_ms BIGINT, task_ms BIGINT,
          read_bytes BIGINT, pruned_files_bytes BIGINT, read_files_bytes BIGINT,
          spilled_local_bytes BIGINT, waiting_at_capacity_ms BIGINT,
          statement_text STRING,
          exec_ms BIGINT, compile_ms BIGINT, compute_wait_ms BIGINT,
          fetch_ms BIGINT, read_rows BIGINT, produced_rows BIGINT,
          from_cache BIGINT, client_app STRING, source_label STRING)""",
         "qa_executions", as_app=True)
    try:  # migrate pre-breakdown stores; Delta has no ADD COLUMN IF NOT EXISTS
        _run(warehouse_id, f"""
            ALTER TABLE {_qa_exec_fqn()} ADD COLUMNS (
              exec_ms BIGINT, compile_ms BIGINT, compute_wait_ms BIGINT,
              fetch_ms BIGINT, read_rows BIGINT, produced_rows BIGINT,
              from_cache BIGINT, client_app STRING, source_label STRING)""",
             "qa_executions (migrate)", as_app=True)
    except LiveError:
        pass  # columns already exist
    _run(warehouse_id, f"""
        CREATE TABLE IF NOT EXISTS {_qa_analysis_fqn()} (
          fingerprint STRING, ai_advice STRING, ai_model STRING, analyzed_at TIMESTAMP)""",
         "qa_analysis", as_app=True)


def _qa_ingest(warehouse_id: str) -> None:
    """Mirror ONLY the not-yet-processed executions into the app store:
    system.query.history is read as the VIEWER (everything past the
    watermark, with a 2-hour overlap for late-arriving rows) and the rows are
    stored as the APP — dedup on statement_id happens at insert. The first
    run backfills the lookback window in _QA_FETCH_LIMIT slices, looping
    until caught up (bounded per call)."""
    for _slice in range(30):
        if not _qa_ingest_slice(warehouse_id):
            break


def _qa_ingest_slice(warehouse_id: str) -> bool:
    """One watermark slice; True when the slice was full (more may remain)."""
    if _store_is_lakebase():
        wm_rows = _pg_exec("SELECT CAST(MAX(start_time) AS text) AS wm FROM qa_executions",
                           fetch=True, source="qa_executions (watermark)")
    else:
        wm_rows = _run(warehouse_id,
                       f"SELECT CAST(MAX(start_time) AS STRING) AS wm FROM {_qa_exec_fqn()}",
                       "qa_executions (watermark)", as_app=True)
    wm = (wm_rows[0].get("wm") if wm_rows else None) or None
    lower = (f"TIMESTAMP'{wm}' - INTERVAL 2 HOURS" if wm
             else f"dateadd(DAY, -{_QA_LOOKBACK_DAYS}, current_timestamp())")
    fetched = _run(warehouse_id, f"""
        SELECT q.statement_id                                 AS statement_id,
               md5(q.statement_text)                          AS fingerprint,
               q.statement_type                               AS statement_type,
               CAST(q.workspace_id AS STRING)                 AS workspace_id,
               q.compute.warehouse_id                         AS warehouse_id,
               q.executed_by                                  AS executed_by,
               CAST(q.start_time AS STRING)                   AS start_time,
               q.total_duration_ms                            AS duration_ms,
               q.total_task_duration_ms                       AS task_ms,
               q.read_bytes                                   AS read_bytes,
               COALESCE(q.pruned_files_bytes, 0)              AS pruned_files_bytes,
               COALESCE(q.read_files_bytes, 0)                AS read_files_bytes,
               COALESCE(q.spilled_local_bytes, 0)             AS spilled_local_bytes,
               COALESCE(q.waiting_at_capacity_duration_ms, 0) AS waiting_at_capacity_ms,
               LEFT(q.statement_text, 4000)                   AS statement_text,
               COALESCE(q.execution_duration_ms, 0)           AS exec_ms,
               COALESCE(q.compilation_duration_ms, 0)         AS compile_ms,
               COALESCE(q.waiting_for_compute_duration_ms, 0) AS compute_wait_ms,
               COALESCE(q.result_fetch_duration_ms, 0)        AS fetch_ms,
               COALESCE(q.read_rows, 0)                       AS read_rows,
               COALESCE(q.produced_rows, 0)                   AS produced_rows,
               CASE WHEN q.from_result_cache THEN 1 ELSE 0 END AS from_cache,
               COALESCE(q.client_application, '')             AS client_app,
               CASE WHEN q.query_source.job_info.job_id IS NOT NULL
                      THEN CONCAT('job ', q.query_source.job_info.job_id)
                    WHEN q.query_source.genie_space_id IS NOT NULL THEN 'Genie space'
                    WHEN q.query_source.dashboard_id IS NOT NULL
                      THEN CONCAT('dashboard ', q.query_source.dashboard_id)
                    WHEN q.query_source.legacy_dashboard_id IS NOT NULL THEN 'legacy dashboard'
                    WHEN q.query_source.notebook_id IS NOT NULL
                      THEN CONCAT('notebook ', q.query_source.notebook_id)
                    WHEN q.query_source.sql_query_id IS NOT NULL THEN 'saved query'
                    ELSE '' END                               AS source_label
        FROM system.query.history q
        WHERE q.start_time > {lower}
          AND q.statement_type = 'SELECT'
          AND q.statement_text IS NOT NULL{_qa_scope_sql(warehouse_id)}
        ORDER BY q.start_time
        LIMIT {_QA_FETCH_LIMIT}""", "system.query.history (ingest)")
    if fetched:
        if _store_is_lakebase():
            def _row(r: dict[str, Any]) -> tuple:
                def n(v: Any) -> int:
                    try:
                        return int(float(v))
                    except (TypeError, ValueError):
                        return 0
                return (r["statement_id"], r["fingerprint"], r["statement_type"],
                        r["workspace_id"], r["warehouse_id"], r["executed_by"],
                        r["start_time"], n(r["duration_ms"]), n(r["task_ms"]),
                        n(r["read_bytes"]), n(r["pruned_files_bytes"]),
                        n(r["read_files_bytes"]), n(r["spilled_local_bytes"]),
                        n(r["waiting_at_capacity_ms"]), r["statement_text"],
                        n(r["exec_ms"]), n(r["compile_ms"]), n(r["compute_wait_ms"]),
                        n(r["fetch_ms"]), n(r["read_rows"]), n(r["produced_rows"]),
                        n(r["from_cache"]), str(r.get("client_app") or ""),
                        str(r.get("source_label") or ""))
            _pg_exec(
                f"INSERT INTO qa_executions ({', '.join(_QA_COLS)}) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s::timestamptz, %s, %s, %s, %s, %s, %s, %s, %s, "
                "%s, %s, %s, %s, %s, %s, %s, %s, %s) "
                "ON CONFLICT (statement_id) DO NOTHING",
                [_row(r) for r in fetched], many=True, source="qa_executions (ingest)")
        else:
            # VALUES-chunked MERGE: the SP cannot read system tables, so rows
            # travel through the app process.
            for i in range(0, len(fetched), 500):
                values = ",".join(
                    "(" + ",".join((
                        f"'{_sql_str(r['statement_id'])}'", f"'{_sql_str(r['fingerprint'])}'",
                        f"'{_sql_str(r['statement_type'])}'", f"'{_sql_str(r['workspace_id'])}'",
                        f"'{_sql_str(r['warehouse_id'])}'", f"'{_sql_str(r['executed_by'])}'",
                        f"'{_sql_str(r['start_time'])}'", _sql_num(r["duration_ms"]),
                        _sql_num(r["task_ms"]), _sql_num(r["read_bytes"]),
                        _sql_num(r["pruned_files_bytes"]), _sql_num(r["read_files_bytes"]),
                        _sql_num(r["spilled_local_bytes"]), _sql_num(r["waiting_at_capacity_ms"]),
                        f"'{_sql_str(r['statement_text'])}'",
                        _sql_num(r["exec_ms"]), _sql_num(r["compile_ms"]),
                        _sql_num(r["compute_wait_ms"]), _sql_num(r["fetch_ms"]),
                        _sql_num(r["read_rows"]), _sql_num(r["produced_rows"]),
                        _sql_num(r["from_cache"]), f"'{_sql_str(r.get('client_app'))}'",
                        f"'{_sql_str(r.get('source_label'))}'")) + ")"
                    for r in fetched[i:i + 500])
                _run(warehouse_id, f"""
                    MERGE INTO {_qa_exec_fqn()} t
                    USING (SELECT col1 AS statement_id, col2 AS fingerprint, col3 AS statement_type,
                                  col4 AS workspace_id, col5 AS warehouse_id, col6 AS executed_by,
                                  CAST(col7 AS TIMESTAMP) AS start_time, col8 AS duration_ms,
                                  col9 AS task_ms, col10 AS read_bytes, col11 AS pruned_files_bytes,
                                  col12 AS read_files_bytes, col13 AS spilled_local_bytes,
                                  col14 AS waiting_at_capacity_ms, col15 AS statement_text,
                                  col16 AS exec_ms, col17 AS compile_ms, col18 AS compute_wait_ms,
                                  col19 AS fetch_ms, col20 AS read_rows, col21 AS produced_rows,
                                  col22 AS from_cache, col23 AS client_app, col24 AS source_label
                           FROM VALUES {values} AS v(col1,col2,col3,col4,col5,col6,col7,col8,col9,col10,col11,col12,col13,col14,col15,col16,col17,col18,col19,col20,col21,col22,col23,col24)) s
                    ON t.statement_id = s.statement_id
                    WHEN NOT MATCHED THEN INSERT *""", "qa_executions (ingest)", as_app=True)
    # Retention.
    if _store_is_lakebase():
        _pg_exec(f"DELETE FROM qa_executions WHERE start_time < now() - interval '{_QA_LOOKBACK_DAYS + 1} days'",
                 source="qa_executions (retention)")
    else:
        _run(warehouse_id,
             f"DELETE FROM {_qa_exec_fqn()} WHERE start_time < dateadd(DAY, -{_QA_LOOKBACK_DAYS + 1}, current_timestamp())",
             "qa_executions (retention)", as_app=True)
    return len(fetched) >= _QA_FETCH_LIMIT


def advisor_payload(warehouse_id: str) -> dict[str, Any]:
    """The "advisor" cache object: incremental-ingest the unprocessed
    query-history tail into the app store, then build the fingerprint rollups
    for both UI windows (24h + 7d)."""
    _qa_ensure(warehouse_id)
    _qa_ingest(warehouse_id)
    return {"rollup_1": _qa_rollup(warehouse_id, 1), "rollup_7": _qa_rollup(warehouse_id, 7)}


def _qa_rollup(warehouse_id: str, days: int) -> list[dict[str, Any]]:
    """Roll the window up from the LOCAL store. Statements are grouped by
    TEXT FINGERPRINT (md5), so repeated dashboard/job queries aggregate into
    one row with meaningful runs/p50/p95. Cost = each warehouse's billed cost
    over the window (billing read as the VIEWER) allocated pro-rata by the
    statement's task-time share. The cap keeps the fingerprints with the most
    TOTAL task time — that's the compute burden cost allocation follows; a
    p95-only cap would keep one-off slow runs and drop cheap-times-10,000
    patterns."""
    if _store_is_lakebase():
        rows = _pg_exec(f"""
            WITH win AS (
                SELECT * FROM qa_executions
                WHERE start_time >= now() - interval '{int(days)} days'
            )
            SELECT w.fingerprint,
                   (array_agg(w.statement_text))[1]                        AS statement_text,
                   (array_agg(w.warehouse_id ORDER BY w.start_time DESC))[1] AS wh,
                   (array_agg(w.executed_by ORDER BY w.start_time DESC))[1]  AS executed_by,
                   (array_agg(w.workspace_id ORDER BY w.start_time DESC))[1] AS ws,
                   COUNT(*)                                                AS runs,
                   percentile_cont(0.50) WITHIN GROUP (ORDER BY w.duration_ms) / 1000.0 AS p50_s,
                   percentile_cont(0.95) WITHIN GROUP (ORDER BY w.duration_ms) / 1000.0 AS p95_s,
                   SUM(w.read_bytes)                                       AS bytes_read,
                   SUM(w.pruned_files_bytes)::float8 /
                     NULLIF(SUM(w.pruned_files_bytes) + SUM(w.read_files_bytes), 0) AS pruning_eff,
                   SUM(w.spilled_local_bytes) / 1e9                        AS spill_gb,
                   SUM(w.waiting_at_capacity_ms)::float8 / NULLIF(SUM(w.duration_ms), 0) AS queued_ratio,
                   SUM(w.task_ms)                                          AS task_ms,
                   SUM(w.duration_ms)                                      AS total_dur_ms,
                   SUM(w.exec_ms)                                          AS exec_ms,
                   SUM(w.compile_ms)                                       AS compile_ms,
                   SUM(w.compute_wait_ms)                                  AS compute_wait_ms,
                   SUM(w.fetch_ms)                                         AS fetch_ms,
                   SUM(w.waiting_at_capacity_ms)                           AS queue_ms,
                   SUM(w.read_rows)                                        AS read_rows,
                   SUM(w.produced_rows)                                    AS produced_rows,
                   SUM(w.from_cache)                                       AS cached_runs,
                   (array_agg(w.client_app ORDER BY w.start_time DESC))[1]   AS client_app,
                   (array_agg(w.source_label ORDER BY w.start_time DESC))[1] AS source_label,
                   CAST(MAX(w.start_time) AS text)                         AS last_run,
                   (array_agg(a.ai_advice))[1]                             AS ai_advice,
                   (array_agg(a.ai_model))[1]                              AS ai_model
            FROM win w LEFT JOIN qa_analysis a ON w.fingerprint = a.fingerprint
            GROUP BY w.fingerprint
            ORDER BY task_ms DESC NULLS LAST
            LIMIT 300""", fetch=True, source="qa rollup")
    else:
        rows = _run(warehouse_id, f"""
            WITH win AS (
                SELECT * FROM {_qa_exec_fqn()}
                WHERE start_time >= dateadd(DAY, -{int(days)}, current_timestamp())
            )
            SELECT w.fingerprint,
                   any_value(w.statement_text)                    AS statement_text,
                   max_by(w.warehouse_id, w.start_time)           AS wh,
                   max_by(w.executed_by, w.start_time)            AS executed_by,
                   max_by(w.workspace_id, w.start_time)           AS ws,
                   COUNT(*)                                       AS runs,
                   percentile(w.duration_ms, 0.50) / 1000.0       AS p50_s,
                   percentile(w.duration_ms, 0.95) / 1000.0       AS p95_s,
                   SUM(w.read_bytes)                              AS bytes_read,
                   SUM(w.pruned_files_bytes) /
                     NULLIF(SUM(w.pruned_files_bytes) + SUM(w.read_files_bytes), 0) AS pruning_eff,
                   SUM(w.spilled_local_bytes) / 1e9               AS spill_gb,
                   SUM(w.waiting_at_capacity_ms) / NULLIF(SUM(w.duration_ms), 0) AS queued_ratio,
                   SUM(w.task_ms)                                 AS task_ms,
                   SUM(w.duration_ms)                             AS total_dur_ms,
                   SUM(w.exec_ms)                                 AS exec_ms,
                   SUM(w.compile_ms)                              AS compile_ms,
                   SUM(w.compute_wait_ms)                         AS compute_wait_ms,
                   SUM(w.fetch_ms)                                AS fetch_ms,
                   SUM(w.waiting_at_capacity_ms)                  AS queue_ms,
                   SUM(w.read_rows)                               AS read_rows,
                   SUM(w.produced_rows)                           AS produced_rows,
                   SUM(w.from_cache)                              AS cached_runs,
                   max_by(w.client_app, w.start_time)             AS client_app,
                   max_by(w.source_label, w.start_time)           AS source_label,
                   CAST(MAX(w.start_time) AS STRING)              AS last_run,
                   any_value(a.ai_advice)                         AS ai_advice,
                   any_value(a.ai_model)                          AS ai_model
            FROM win w LEFT JOIN {_qa_analysis_fqn()} a ON w.fingerprint = a.fingerprint
            GROUP BY w.fingerprint
            ORDER BY task_ms DESC NULLS LAST
            LIMIT 300""", "qa rollup", as_app=True)
    # Billed warehouse cost + the allocation base (task-time of ALL statement
    # types) over the window — system-table reads, so they run as the viewer;
    # per-statement allocation happens in-process.
    # Deliberately UNSCOPED billing/task scans: allocation is a per-warehouse
    # ratio (statement task-time ÷ warehouse task-time × warehouse $), and a
    # warehouse lives in exactly one workspace — only warehouses of the
    # scope-filtered mirror rows are ever looked up, so scoping here would
    # change nothing but add a predicate.
    usd_by_wh: dict[str, float] = {}
    task_by_wh: dict[str, float] = {}
    try:
        cost_rows = _run(warehouse_id, f"""
            SELECT u.usage_metadata.warehouse_id AS wh,
                   SUM(u.usage_quantity*lp.pricing.effective_list.default) AS usd
            FROM system.billing.usage u
            LEFT JOIN system.billing.list_prices lp ON u.cloud=lp.cloud AND u.sku_name=lp.sku_name
             AND u.usage_start_time>=lp.price_start_time AND (lp.price_end_time IS NULL OR u.usage_start_time<lp.price_end_time)
            WHERE u.usage_date >= dateadd(DAY, -{int(days)}, current_date())
              AND u.usage_metadata.warehouse_id IS NOT NULL
            GROUP BY 1""", "system.billing.usage (warehouse cost)")
        usd_by_wh = {str(r.get("wh")): _f(r.get("usd")) for r in cost_rows}
        task_rows = _run(warehouse_id, f"""
            SELECT q.compute.warehouse_id AS wh, SUM(q.total_task_duration_ms) AS task_ms
            FROM system.query.history q
            WHERE q.start_time >= dateadd(DAY, -{int(days)}, current_timestamp())
            GROUP BY 1""", "system.query.history (allocation base)")
        task_by_wh = {str(r.get("wh")): _f(r.get("task_ms")) for r in task_rows}
    except LiveError:
        pass  # advisor still serves; cost shows 0 rather than failing the page
    for r in rows:
        wh = str(r.get("wh") or "")
        base = task_by_wh.get(wh, 0.0)
        r["cost_usd"] = (usd_by_wh.get(wh, 0.0) * _f(r.get("task_ms")) / base) if base else 0.0
    return rows


def _fmt_dur(seconds: float) -> str:
    """Human duration: 42s, 6m 05s, 1h 40m."""
    s = int(round(seconds))
    if s < 60:
        return f"{s}s"
    m, s = divmod(s, 60)
    if m < 60:
        return f"{m}m {s:02d}s" if s else f"{m}m"
    h, m = divmod(m, 60)
    return f"{h}h {m:02d}m"


# Wall-time phases mirrored per execution — (rollup column, human label).
_QA_PHASES = (
    ("queue_ms", "queued at capacity"),
    ("compute_wait_ms", "waiting for compute start"),
    ("compile_ms", "compiling"),
    ("exec_ms", "executing"),
    ("fetch_ms", "fetching results"),
)


def _phase_shares(raw: dict[str, Any]) -> dict[str, float]:
    """Each phase's share of measured time (0 when the mirror predates the
    breakdown columns — old rows age out with retention). The denominator is
    the LARGER of wall time and the phase sum: result_fetch continues after
    execution finishes, so fetch alone can exceed total_duration_ms."""
    total = _f(raw.get("total_dur_ms"))
    phase_sum = sum(_f(raw.get(col)) for col, _ in _QA_PHASES)
    denom = max(total, phase_sum)
    if denom <= 0:
        return {col: 0.0 for col, _ in _QA_PHASES}
    return {col: min(1.0, max(0.0, _f(raw.get(col)) / denom)) for col, _ in _QA_PHASES}


def _phase_text(shares: dict[str, float], top: int = 2) -> str:
    """'62% executing, 21% fetching results' — the top phases ≥5%."""
    parts = [(share, label) for (col, label) in _QA_PHASES
             for share in [shares.get(col, 0.0)] if share >= 0.05]
    parts.sort(reverse=True)
    return ", ".join(f"{round(s * 100)}% {label}" for s, label in parts[:top])


def _ai_prompt(days: int, row: dict[str, Any], raw: dict[str, Any]) -> str:
    text = " ".join((raw.get("statement_text") or "").split())[:1800]
    breakdown = _phase_text(_phase_shares(raw), top=3) or "n/a"
    return (
        "You are a Databricks SQL performance reviewer. Measured over the last "
        f"{days} day(s): runs={row['runs']}, p95={row['p95_s']}s, spill={row['spill_gb']}GB, "
        f"files pruned={round(row['pruning_efficiency'] * 100)}%, "
        f"queued={round(row['queued_ratio'] * 100)}% of runtime, "
        f"rows returned={int(_f(raw.get('produced_rows')))}, wall time split: {breakdown}, "
        f"window cost=${row['cost_usd']}. "
        "Give at most 3 concrete optimisations for this SQL as '- ' bullets, max 60 words total, "
        "most impactful first (filters/partition pruning, join order, aggregation pushdown; warehouse "
        "sizing only if queueing/spill indicates it). If the SQL itself cannot be improved, reply "
        "exactly: No SQL-level improvements identified.\nSQL: " + text
    )


def _ai_enrich_async(warehouse_id: str, items: list[tuple[str, str]], endpoint: str) -> None:
    """Fire-and-forget ai_query enrichment — each query text is analysed
    ONCE, ever. The model call (ai_query over VALUES — no table access) runs
    as the VIEWER on the warehouse; the resulting advice is stored as the
    APP. Never blocks or breaks serving; capped per cycle."""
    if not items or not _AI_LOCK.acquire(blocking=False):
        return

    # The thread outlives the request, and contextvars don't cross threads —
    # carry the viewer's token + identity over (the advisor cache row being
    # rebuilt is the viewer's own).
    token = USER_TOKEN.get()
    uid = USER_ID.get()

    def _work() -> None:
        USER_TOKEN.set(token)
        USER_ID.set(uid)
        try:
            values = ",".join(f"('{_sql_str(fp)}', '{_sql_str(p)}')" for fp, p in items)
            advices = _run(warehouse_id, f"""
                SELECT col1 AS fingerprint, ai_query('{endpoint}', col2) AS ai_advice
                FROM VALUES {values} AS v(col1, col2)""", "ai_query")
            got = [(str(a.get("fingerprint") or ""), str(a.get("ai_advice") or ""))
                   for a in advices if a.get("fingerprint") and a.get("ai_advice")]
            if got and _store_is_lakebase():
                _pg_ensure()
                _pg_exec(
                    "INSERT INTO qa_analysis (fingerprint, ai_advice, ai_model, analyzed_at) "
                    "VALUES (%s, %s, %s, now()) ON CONFLICT (fingerprint) DO NOTHING",
                    [(fp, adv, endpoint) for fp, adv in got], many=True,
                    source="qa_analysis (store)")
            elif got:
                vals = ",".join(f"('{_sql_str(fp)}', '{_sql_str(adv)}')" for fp, adv in got)
                _run(warehouse_id, f"""
                    MERGE INTO {_qa_analysis_fqn()} t
                    USING (SELECT col1 AS fingerprint, col2 AS ai_advice
                           FROM VALUES {vals} AS v(col1, col2)) s
                    ON t.fingerprint = s.fingerprint
                    WHEN NOT MATCHED THEN INSERT (fingerprint, ai_advice, ai_model, analyzed_at)
                    VALUES (s.fingerprint, s.ai_advice, '{endpoint}', current_timestamp())""",
                     "qa_analysis (store)", as_app=True)
            # Rebuild the cached advisor object so the stored advice is
            # visible immediately (and the next flagged batch gets picked up
            # on the next page poll).
            _cache_write(warehouse_id, "advisor", _viewer_principal(),
                         json.dumps(advisor_payload(warehouse_id), default=_json_default))
        except LiveError:
            pass
        finally:
            _AI_LOCK.release()

    threading.Thread(target=_work, daemon=True, name="qa-ai-enrich").start()


def analyse_now(warehouse_id: str, fingerprint: str) -> dict[str, Any]:
    """On-demand ai_query review of ONE fingerprint (the "Review with AI now"
    button): the model call runs synchronously as the VIEWER; the advice is
    stored as the APP and patched into the viewer's cached advisor rollups so
    the page shows it immediately — no waiting for the background batch."""
    from data.config import get_features, get_settings

    endpoint = str(get_settings().get("llm_endpoint") or "")
    if not (get_features().get("ai_narration") and endpoint):
        raise LiveError("ai review", "LLM narration is disabled on this deployment (features.ai_narration)")
    payload = _cached_payload("advisor", warehouse_id)
    raw, days = None, 7
    for key, d in (("rollup_7", 7), ("rollup_1", 1)):
        for r in payload.get(key) or []:
            if str(r.get("fingerprint")) == fingerprint:
                raw, days = r, d
                break
        if raw:
            break
    if raw is None:
        raise LiveError("ai review", f"unknown statement fingerprint: {fingerprint!r}")
    prune = _f(raw.get("pruning_eff"))
    prompt = _ai_prompt(days, {
        "runs": int(_f(raw.get("runs"))), "p95_s": round(_f(raw.get("p95_s")), 2),
        "spill_gb": round(_f(raw.get("spill_gb")), 2),
        "pruning_efficiency": 0.0 if prune < 0 else (1.0 if prune > 1 else prune),
        "queued_ratio": round(_f(raw.get("queued_ratio")), 3),
        "cost_usd": round(_f(raw.get("cost_usd")), 2),
    }, raw)
    advices = _run(warehouse_id,
                   f"SELECT ai_query('{endpoint}', '{_sql_str(prompt)}') AS ai_advice", "ai_query")
    advice = str((advices[0] if advices else {}).get("ai_advice") or "").strip()
    if not advice:
        raise LiveError("ai review", "the model returned no advice")
    if _store_is_lakebase():
        _pg_ensure()
        _pg_exec(
            "INSERT INTO qa_analysis (fingerprint, ai_advice, ai_model, analyzed_at) "
            "VALUES (%s, %s, %s, now()) "
            "ON CONFLICT (fingerprint) DO UPDATE SET ai_advice = EXCLUDED.ai_advice, "
            "ai_model = EXCLUDED.ai_model, analyzed_at = now()",
            [(fingerprint, advice, endpoint)], many=True, source="qa_analysis (store)")
    else:
        _run(warehouse_id, f"""
            MERGE INTO {_qa_analysis_fqn()} t
            USING (SELECT '{_sql_str(fingerprint)}' AS fingerprint,
                          '{_sql_str(advice)}' AS ai_advice) s
            ON t.fingerprint = s.fingerprint
            WHEN MATCHED THEN UPDATE SET t.ai_advice = s.ai_advice,
                 t.ai_model = '{endpoint}', t.analyzed_at = current_timestamp()
            WHEN NOT MATCHED THEN INSERT (fingerprint, ai_advice, ai_model, analyzed_at)
            VALUES (s.fingerprint, s.ai_advice, '{endpoint}', current_timestamp())""",
             "qa_analysis (store)", as_app=True)
    # Patch the cached rollups in place — the advice is visible on the next
    # page read without a full ingest+rollup rebuild.
    for key in ("rollup_7", "rollup_1"):
        for r in payload.get(key) or []:
            if str(r.get("fingerprint")) == fingerprint:
                r["ai_advice"] = advice
                r["ai_model"] = endpoint
    _cache_write(warehouse_id, "advisor", _viewer_principal(),
                 json.dumps(payload, default=_json_default))
    return {"fingerprint": fingerprint, "ai_advice": advice, "ai_model": endpoint}


def queries_live(warehouse_id: str, time_range: str = "24h") -> list[dict[str, Any]]:
    """Query Advisor rows: cached rollups + deterministic classification +
    (when ai_narration is on) ai_query advice per fingerprint."""
    from data.config import get_features, get_settings

    days = _QUERY_DAYS.get(time_range, 7)
    payload = _cached_payload("advisor", warehouse_id)
    raw = payload["rollup_7" if days >= 7 else "rollup_1"]
    endpoint = str(get_settings().get("llm_endpoint") or "")
    ai_on = bool(get_features().get("ai_narration")) and bool(endpoint)

    rows: list[dict[str, Any]] = []
    todo: list[tuple[str, str]] = []
    for r in raw:
        p95 = _f(r.get("p95_s"))
        spill = _f(r.get("spill_gb"))
        queued = _f(r.get("queued_ratio"))
        prune = _f(r.get("pruning_eff"))
        prune = 0.0 if prune < 0 else (1.0 if prune > 1 else prune)
        flags = []
        if p95 >= 60:
            flags.append("slow")
        if spill > 1:
            flags.append("high-spill")
        if queued > 0.3:
            flags.append("capacity-bound")
        if prune < 0.3 and _f(r.get("bytes_read")) > 1e10:
            flags.append("full-scan")
        runs = int(_f(r.get("runs")))
        cached_runs = int(_f(r.get("cached_runs")))
        produced = int(_f(r.get("produced_rows")))
        shares = _phase_shares(r)
        # Rows mirrored before the breakdown columns existed read as all-zero —
        # those metrics are UNKNOWN for them, not zero (they age out with
        # retention).
        has_breakdown = any(shares[col] > 0 for col, _ in _QA_PHASES)
        breakdown = _phase_text(shares) if has_breakdown else ""
        wh = str(r.get("wh") or "")
        # Runs-aware duration phrasing — "p95 over 1 runs" is meaningless.
        dur_desc = (f"ran once, took {_fmt_dur(p95)}" if runs == 1
                    else f"{runs} runs · median {_fmt_dur(_f(r.get('p50_s')))} · p95 {_fmt_dur(p95)}")
        row = {
            "id": r.get("fingerprint"), "statement_id": r.get("fingerprint"),
            "query_text": (r.get("statement_text") or "")[:500],
            "user": r.get("executed_by"), "warehouse": wh,
            "workspace": str(r.get("ws") or ""),
            "runs": runs,
            "p50_s": round(_f(r.get("p50_s")), 2), "p95_s": round(p95, 2),
            "bytes_read": _f(r.get("bytes_read")),
            "pruning_efficiency": round(prune, 3), "spill_gb": round(spill, 2),
            "cost_usd": round(_f(r.get("cost_usd")), 2),
            "queued_ratio": round(queued, 3), "target_table": None,
            "flags": flags,
            "severity": "High" if (p95 >= 120 or spill > 5) else ("Medium" if p95 >= 60 else "Low"),
            # Wall-time breakdown + provenance (measured; 0/'' on rows
            # mirrored before the breakdown columns existed).
            "total_dur_s": round(_f(r.get("total_dur_ms")) / 1000.0, 1),
            "phase_shares": ({col: round(s, 3) for col, s in shares.items()}
                             if has_breakdown else None),
            "read_rows": int(_f(r.get("read_rows"))) if has_breakdown else None,
            "produced_rows": produced if has_breakdown else None,
            "cached_runs": cached_runs if has_breakdown else None,
            "client_app": str(r.get("client_app") or ""),
            "source_label": str(r.get("source_label") or ""),
            "last_run": str(r.get("last_run") or "")[:19],
        }
        # Classify from the measured metrics of this statement — one insight
        # per dominant signal, "healthy" when nothing fires. Every rationale
        # and step carries the numbers that triggered it.
        if queued > 0.3:
            itype = "capacity"
            rationale = f"{round(queued*100)}% of wall time queued at warehouse capacity — {dur_desc}"
            steps = [
                f"Right-size warehouse {wh} or enable autoscaling — {round(queued*100)}% of this statement's wall time is queueing",
                "Check what else runs on this warehouse at the same times and stagger the schedules",
            ]
        elif spill > 1:
            itype = "spill"
            rationale = f"{round(spill,1)} GB spilled to local disk (memory pressure) — {dur_desc}"
            steps = [
                f"Run on a larger warehouse size: {round(spill,1)} GB spilled out of memory in the window",
                "Cut shuffle width — pre-aggregate before wide joins and avoid row-exploding joins",
            ]
        elif prune < 0.3 and _f(row.get("bytes_read")) > 1e10:
            itype = "full-scan"
            rationale = (f"only {round(prune*100)}% of files pruned over "
                         f"{round(_f(row.get('bytes_read'))/1e9)} GB read — near-full scans; {dur_desc}")
            steps = [
                f"Add selective filters on partition/clustering keys — {round(_f(row.get('bytes_read'))/1e9)} GB read, {round(prune*100)}% pruned",
                "Liquid-cluster the scanned table on the common filter keys (Tables → layout health)",
            ]
        elif p95 >= 60:
            itype = "slow-query"
            rationale = f"{dur_desc}" + (f" — time went: {breakdown}" if breakdown else "")
            steps = []
            if has_breakdown:
                if shares["fetch_ms"] > 0.3:
                    steps.append(f"{round(shares['fetch_ms']*100)}% of wall time returns results to the client"
                                 f" ({produced:,} rows) — SELECT fewer columns/rows or aggregate server-side")
                if shares["compute_wait_ms"] > 0.3:
                    steps.append(f"{round(shares['compute_wait_ms']*100)}% waited for compute start (cold warehouse)"
                                 " — align auto-stop with the query cadence or use serverless")
                if shares["compile_ms"] > 0.3:
                    steps.append(f"{round(shares['compile_ms']*100)}% is compilation — simplify repeated CTEs/branches"
                                 " or batch many small statements")
                if shares["exec_ms"] >= 0.5 or not steps:
                    steps.append(f"Execution-dominant ({round(shares['exec_ms']*100)}%) — open the query profile"
                                 " and check the top operator; the AI review below reads the SQL itself")
                if produced > 1_000_000:
                    steps.append(f"Returns {produced:,} rows — if this is an extract, aggregate it or export once instead")
            else:
                # Mirrored before phase capture — no breakdown to point at.
                steps.append("Open this statement's query profile in the workspace UI and check the dominant"
                             " operator; the AI review below reads the SQL itself")
            if runs >= 5:
                steps.append(f"Ran {runs}× in the window — materialise the result or lean on the result cache")
            steps = steps[:3]
        else:
            itype = "healthy"
            rationale = "no cost or performance flags from this statement's measured metrics"
            steps = []
        if cached_runs:
            rationale += f" · {cached_runs} of {runs} runs served from the result cache"
        advice = str(r.get("ai_advice") or "") or None
        row.update({
            "insight_type": itype, "rationale": rationale, "insight_rationale": rationale,
            "confidence": None,
            "impact": min(100, round(p95)),
            "next_steps": steps,
            "ai_advice": advice,
            "ai_model": str(r.get("ai_model") or "") or None,
            "ai_pending": bool(ai_on and itype != "healthy" and not advice),
        })
        rows.append(row)
        if ai_on and itype != "healthy" and not advice and r.get("fingerprint"):
            todo.append((str(r["fingerprint"]), _ai_prompt(days, row, r)))
    if todo:
        # Highest-cost unanalysed statements first; bounded batch per cycle.
        todo.sort(key=lambda t: -next((x["cost_usd"] for x in rows if x["id"] == t[0]), 0))
        _ai_enrich_async(warehouse_id, todo[:_AI_BATCH], endpoint)
    return rows
