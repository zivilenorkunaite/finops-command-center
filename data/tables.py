"""Tables tab: honest Unity Catalog + legacy HMS inventory, plus MEASURED
layout health — DESCRIBE DETAIL probes of the viewer's most-read tables
(information_schema is permission-filtered, so candidates come from a JOIN
with lineage reads) and Predictive Optimization activity. Bounded probing
is the honest trade-off: sizing every table would need thousands of
statements.
"""
from __future__ import annotations

import json
import time
from typing import Any
from data.cache import _cached_payload
from data.runtime import LiveError, _f, _run, _sql_str


def tables_summary(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """KPI rollup over the (possibly filtered) tables rows — counts only,
    every one real."""
    def n(*types: str) -> int:
        return sum(1 for r in rows if r.get("table_type") in types)

    managed, external = n("MANAGED"), n("EXTERNAL")
    base = managed + external
    return {
        "num_objects": len(rows),
        "num_managed": managed,
        "num_external": external,
        "pct_managed": round(managed / base, 3) if base else 0.0,
        "num_foreign": n("FOREIGN"),
        "num_views": n("VIEW", "MATERIALIZED_VIEW", "METRIC_VIEW", "STREAMING_TABLE"),
        "num_hms": n("HMS"),
    }


# Only REAL catalog metadata is served — physical layout (file counts, sizes,
# OPTIMIZE/VACUUM history) would need per-table DESCRIBE DETAIL collection,
# which this app does not run, so those metrics are not shown at all.
_TABLE_CAVEAT = ("Inventory from system.information_schema.tables — catalog metadata "
                 "only. Physical layout (file counts, sizes, OPTIMIZE/VACUUM history) "
                 "is not collected and therefore not shown.")


def tables_live(warehouse_id: str) -> list[dict[str, Any]]:
    raw = _run(warehouse_id, """
        SELECT table_catalog, table_schema, table_name, table_type,
               COALESCE(data_source_format, '') AS fmt,
               COALESCE(table_owner, '')        AS owner,
               CAST(created AS STRING)          AS created,
               CAST(last_altered AS STRING)     AS last_altered
        FROM system.information_schema.tables
        WHERE table_catalog NOT IN ('system', 'samples')
          AND table_catalog NOT LIKE '\\_\\_databricks\\_internal%'
          AND table_schema <> 'information_schema'
        ORDER BY table_catalog, table_schema, table_name
        LIMIT 2000""", "system.information_schema.tables")
    rows = []
    for r in raw:
        cat, sch, tab = r.get("table_catalog"), r.get("table_schema"), r.get("table_name")
        rows.append({
            "fqn": f"{cat}.{sch}.{tab}", "catalog": cat, "schema": sch, "table": tab,
            "table_type": (r.get("table_type") or "MANAGED"),
            "format": str(r.get("fmt") or ""),
            "owner": str(r.get("owner") or ""),
            "created": str(r.get("created") or "")[:10],
            "last_altered": str(r.get("last_altered") or "")[:10],
            "recommendation": "None", "needs_action": False,
            "rationale": "", "caveat": _TABLE_CAVEAT, "next_steps": [],
        })
    rows.extend(_hms_tables(warehouse_id))
    return rows


_HMS_CAVEAT = ("Legacy hive_metastore table — outside Unity Catalog governance: no lineage, "
               "no fine-grained grants, no system-table coverage. Flagged for migration to "
               "Unity Catalog; physical detail and managed/external type are not collected "
               "for HMS objects.")

_HMS_NEXT_STEPS = [
    "Migrate to a Unity Catalog catalog: CREATE TABLE <uc_catalog>.<schema>.<table> AS SELECT (or SYNC for external locations)",
    "Repoint jobs/queries to the Unity Catalog name, then drop the hive_metastore copy",
]


def _hms_tables(warehouse_id: str) -> list[dict[str, Any]]:
    """READ-ONLY inventory of legacy hive_metastore tables, each flagged
    convert-to-managed. The app never writes to hive_metastore — existing
    tables there are a governance finding to surface, not to hide.
    information_schema doesn't cover HMS, so this enumerates via SHOW
    SCHEMAS/TABLES (capped to keep round-trips bounded)."""
    out: list[dict[str, Any]] = []
    try:
        schemas = [str(r.get("databaseName") or r.get("namespace") or "")
                   for r in _run(warehouse_id, "SHOW SCHEMAS IN hive_metastore", "hive_metastore schemas")]
    except LiveError:
        return out  # no HMS access on this warehouse — nothing to flag
    for sch in [x for x in schemas if x][:20]:
        safe = sch.replace("`", "``")
        try:
            tabs = _run(warehouse_id, f"SHOW TABLES IN hive_metastore.`{safe}`", f"hive_metastore.{sch}")
        except LiveError:
            continue
        for r in tabs:
            tab = r.get("tableName")
            if not tab:
                continue
            out.append({
                "fqn": f"hive_metastore.{sch}.{tab}", "catalog": "hive_metastore",
                "schema": sch, "table": tab,
                "table_type": "HMS", "format": "", "owner": "",
                "created": "", "last_altered": "",
                "recommendation": "convert-to-managed", "needs_action": True,
                "rationale": _HMS_CAVEAT, "caveat": _HMS_CAVEAT,
                "next_steps": list(_HMS_NEXT_STEPS),
            })
    return out


# ---------------------------------------------------------------------------
# Table health — measured physical layout of the estate's most-read tables.
# Sizing EVERY inventoried table would need thousands of DESCRIBE DETAIL
# statements, so probing is bounded to the tables whose layout actually
# matters to workloads (top by 30-day lineage reads) plus an on-demand probe
# for any single inventory row. All probes run as the viewer.
# ---------------------------------------------------------------------------
_HEALTH_PROBE_CAP = 40


def _bt(part: str) -> str:
    """Backtick-quote one identifier part."""
    return "`" + str(part).replace("`", "``") + "`"


def _fqn_sql(fqn: str) -> str:
    return ".".join(_bt(p) for p in str(fqn).split("."))


def _parse_cols(v: Any) -> list[str]:
    """DESCRIBE DETAIL array columns arrive as JSON-ish strings over the
    Statement Execution API."""
    if isinstance(v, list):
        return [str(x) for x in v]
    s = str(v or "").strip()
    if not s or s in ("[]", "null", "None"):
        return []
    try:
        out = json.loads(s)
        return [str(x) for x in out] if isinstance(out, list) else []
    except (ValueError, TypeError):
        return [p.strip(' "') for p in s.strip("[]").split(",") if p.strip(' "')]


def _describe_detail(warehouse_id: str, fqn: str) -> dict[str, Any] | None:
    """Physical layout of ONE table via DESCRIBE DETAIL, as the viewer.
    None when the viewer can't describe it (or it isn't a Delta table).
    One retry absorbs transient statement failures — a 40-probe run right
    after a restart otherwise loses tables to warehouse queueing."""
    rows: list[dict[str, Any]] | None = None
    for attempt in (1, 2):
        try:
            rows = _run(warehouse_id, f"DESCRIBE DETAIL {_fqn_sql(fqn)}", f"DESCRIBE DETAIL {fqn}")
            break
        except LiveError:
            if attempt == 2:
                return None
            time.sleep(2)
    if not rows:
        return None
    r = rows[0]
    size = int(_f(r.get("sizeInBytes")))
    files = int(_f(r.get("numFiles")))
    return {
        "format": str(r.get("format") or ""),
        "size_bytes": size,
        "num_files": files,
        "avg_file_mb": round(size / files / 1048576, 2) if files else 0.0,
        "partition_cols": _parse_cols(r.get("partitionColumns")),
        "clustering_cols": _parse_cols(r.get("clusteringColumns")),
        "last_modified": str(r.get("lastModified") or "")[:19],
    }


def _table_flags(table_type: str, d: dict[str, Any]) -> list[dict[str, str]]:
    """Deterministic best-practice flags over MEASURED layout facts (WAF cost
    & performance guidance: compact small files, prefer liquid clustering
    over Hive-style partitions, managed tables get Predictive Optimization).
    Only what DESCRIBE DETAIL shows — no churn or history heuristics."""
    flags: list[dict[str, str]] = []
    size_gb = d["size_bytes"] / 1024 ** 3
    # Exact average, not the rounded display value — tiny files round to 0.0.
    avg_mb = (d["size_bytes"] / d["num_files"] / 1048576) if d["num_files"] else 0.0
    if d["num_files"] >= 64 and avg_mb < 16:
        flags.append({
            "id": "small-files", "label": "Small files",
            "action": (f"{d['num_files']:,} files averaging {avg_mb:.2f} MB — compact with OPTIMIZE; "
                       "on managed tables Predictive Optimization does this automatically."),
        })
    if d["partition_cols"] and size_gb < 1024:
        flags.append({
            "id": "over-partitioned", "label": "Hive-style partitions",
            "action": (f"Partitioned by {', '.join(d['partition_cols'])} at {size_gb:,.1f} GB — tables under "
                       "~1 TB rarely benefit from partitioning; switch to liquid clustering "
                       "(ALTER TABLE … CLUSTER BY)."),
        })
    if not d["partition_cols"] and not d["clustering_cols"] and size_gb >= 10:
        flags.append({
            "id": "no-clustering", "label": "No clustering",
            "action": ("Frequently read with no liquid clustering or partitioning — CLUSTER BY the common "
                       "filter/join keys, or CLUSTER BY AUTO to let Databricks pick them."),
        })
    if table_type == "EXTERNAL":
        flags.append({
            "id": "external", "label": "External",
            "action": ("External tables get no Predictive Optimization (auto OPTIMIZE / VACUUM / clustering) — "
                       "consider migrating to a managed table."),
        })
    return flags


def _po_ops_by_table(warehouse_id: str) -> tuple[dict[str, dict[str, Any]], int]:
    """Successful Predictive Optimization ops in the last 30 days keyed by
    table FQN, plus the estate-wide op count. ({}, -1) when the PO history
    table isn't readable — the feature degrades, nothing is invented."""
    try:
        rows = _run(warehouse_id, """
            SELECT catalog_name || '.' || schema_name || '.' || table_name AS fqn,
                   COUNT(*) AS ops,
                   CAST(MAX(end_time) AS STRING) AS last_op,
                   array_join(array_sort(collect_set(operation_type)), ', ') AS op_types
            FROM system.storage.predictive_optimization_operations_history
            WHERE start_time >= dateadd(DAY, -30, current_timestamp())
              AND operation_status = 'SUCCESSFUL'
            GROUP BY 1""", "system.storage.predictive_optimization_operations_history")
    except LiveError:
        return {}, -1
    out = {str(r.get("fqn")): {"ops": int(_f(r.get("ops"))),
                               "last_op": str(r.get("last_op") or "")[:19],
                               "op_types": str(r.get("op_types") or "")}
           for r in rows}
    return out, sum(v["ops"] for v in out.values())


def table_health_live(warehouse_id: str) -> dict[str, Any]:
    """Layout health of the viewer's most-read tables. information_schema is
    privilege-filtered per viewer while lineage logs reads estate-wide, so
    candidates come from a JOIN: the MANAGED/EXTERNAL base tables the VIEWER
    can see, ranked by 30-day lineage reads. Each is probed with DESCRIBE
    DETAIL (as the viewer) and joined with Predictive Optimization activity —
    tables the viewer can't see are honestly out of scope, never guessed."""
    candidates = _run(warehouse_id, """
        SELECT t.table_catalog || '.' || t.table_schema || '.' || t.table_name AS fqn,
               t.table_type, COALESCE(t.table_owner, '') AS owner, l.reads
        FROM system.information_schema.tables t
        JOIN (SELECT source_table_full_name AS sfqn, COUNT(*) AS reads
              FROM system.access.table_lineage
              WHERE event_time >= dateadd(DAY, -30, current_timestamp())
                AND source_table_full_name IS NOT NULL
              GROUP BY 1) l
          ON l.sfqn = t.table_catalog || '.' || t.table_schema || '.' || t.table_name
        WHERE t.table_type IN ('MANAGED', 'EXTERNAL')
          AND t.table_catalog NOT IN ('system', 'samples')
          AND t.table_catalog NOT LIKE '\\_\\_databricks\\_internal%'
          AND t.table_schema <> 'information_schema'
        ORDER BY l.reads DESC
        LIMIT 60""",
        "system.access.table_lineage × information_schema.tables (top-read visible tables)")
    po_map, po_total = _po_ops_by_table(warehouse_id)

    rows: list[dict[str, Any]] = []
    skipped = 0
    for c in candidates:
        if len(rows) + skipped >= _HEALTH_PROBE_CAP:
            break
        fqn = str(c.get("fqn") or "")
        d = _describe_detail(warehouse_id, fqn)
        if d is None:
            skipped += 1
            continue
        table_type = str(c.get("table_type") or "")
        po = po_map.get(fqn, {})
        rows.append({
            "fqn": fqn, "table_type": table_type, "owner": str(c.get("owner") or ""),
            "reads_30d": int(_f(c.get("reads"))),
            **d,
            "po_ops_30d": po.get("ops", 0),
            "po_last": po.get("last_op", ""),
            "po_types": po.get("op_types", ""),
            "flags": _table_flags(table_type, d),
        })
    rows.sort(key=lambda x: -x["size_bytes"])
    return {
        "criteria": (f"tables visible to you (information_schema is permission-filtered) ranked by "
                     f"30-day lineage reads, probed one-by-one with DESCRIBE DETAIL as you "
                     f"(capped at {_HEALTH_PROBE_CAP})"),
        "probed": len(rows),
        "skipped_no_access": skipped,
        "flagged": sum(1 for x in rows if x["flags"]),
        "total_size_bytes": int(sum(x["size_bytes"] for x in rows)),
        "po_available": po_total >= 0,
        "po_ops_30d_estate": max(po_total, 0),
        "rows": rows,
    }


def table_probe_live(warehouse_id: str, fqn: str) -> dict[str, Any]:
    """On-demand DESCRIBE DETAIL for ONE inventoried table (row expand on the
    Tables page), validated against the inventory so only known tables are
    probed. Runs as the viewer."""
    inv = {t["fqn"]: t for t in _cached_payload("tables", warehouse_id)}
    t = inv.get(fqn)
    if t is None:
        raise LiveError("table probe", f"unknown table: {fqn!r}")
    d = _describe_detail(warehouse_id, fqn)
    if d is None:
        raise LiveError("table probe",
                        f"DESCRIBE DETAIL failed for {fqn} — not a Delta table, or your "
                        "permissions don't allow describing it")
    parts = fqn.split(".")
    po: dict[str, Any] = {}
    if len(parts) == 3:
        cat, sch, tab = (_sql_str(p) for p in parts)
        try:
            po_rows = _run(warehouse_id, f"""
                SELECT COUNT(*) AS ops, CAST(MAX(end_time) AS STRING) AS last_op,
                       array_join(array_sort(collect_set(operation_type)), ', ') AS op_types
                FROM system.storage.predictive_optimization_operations_history
                WHERE start_time >= dateadd(DAY, -30, current_timestamp())
                  AND operation_status = 'SUCCESSFUL'
                  AND catalog_name = '{cat}' AND schema_name = '{sch}' AND table_name = '{tab}'""",
                "system.storage.predictive_optimization_operations_history")
            if po_rows and int(_f(po_rows[0].get("ops"))):
                po = {"ops": int(_f(po_rows[0].get("ops"))),
                      "last_op": str(po_rows[0].get("last_op") or "")[:19],
                      "op_types": str(po_rows[0].get("op_types") or "")}
        except LiveError:
            pass  # PO history not readable — probe still returns layout facts
    return {
        "fqn": fqn, "table_type": t["table_type"],
        **d,
        "po_ops_30d": po.get("ops", 0),
        "po_last": po.get("last_op", ""),
        "po_types": po.get("op_types", ""),
        "flags": _table_flags(t["table_type"], d),
    }
