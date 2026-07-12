"""Data Quality tab, in three layers that each degrade honestly: monitors
DISCOVERED from their Lakehouse-Monitoring output tables; monitoring cost
from billing; quality statuses from the optional system table only when the
viewer holds that (account-admin) grant.
"""
from __future__ import annotations

from typing import Any
from data.runtime import LiveError, _f, _run
from data.store import _ws_scope_sql


# ---------------------------------------------------------------------------
# Data Quality Monitoring — inventory from system.data_quality_monitoring +
# the DATA_QUALITY_MONITORING billing cost tie-in. Fields the system table
# doesn't carry (drift PSI/KS, null %, per-table cost) are left blank.
# ---------------------------------------------------------------------------
def _dq_quality(status: str) -> str:
    s = (status or "").upper()
    if "UNHEALTHY" in s or "ERROR" in s or "FAIL" in s:
        return "Critical"
    if "HEALTHY" in s or "OK" in s:
        return "Good"
    return "Warning"


def _dq_freshness(status: str) -> str:
    s = (status or "").upper()
    if "STALE" in s or "UNHEALTHY" in s:
        return "Stale"
    if "HEALTHY" in s or "FRESH" in s or "OK" in s:
        return "Fresh"
    return "OK"


def dqm_live(warehouse_id: str) -> dict[str, Any]:
    """Data quality in three layers, each degrading honestly:
    (1) monitors DISCOVERED from their Lakehouse-Monitoring output tables
        (*_profile_metrics / *_drift_metrics in information_schema — always
        visible to the viewer for tables they can see);
    (2) DATA_QUALITY_MONITORING cost by workspace from billing;
    (3) quality/freshness statuses from
        system.data_quality_monitoring.table_results ONLY when the viewer
        holds that (account-admin) grant — the page states which layers are
        live instead of zero-filling columns."""
    inv = _run(warehouse_id, """
        SELECT table_catalog AS c, table_schema AS s, table_name AS t,
               COALESCE(table_owner, '') AS owner,
               timestampdiff(HOUR, last_altered, current_timestamp()) AS hours_ago
        FROM system.information_schema.tables
        WHERE (table_name LIKE '%\\_profile\\_metrics' OR table_name LIKE '%\\_drift\\_metrics')
          AND table_catalog NOT IN ('system', 'samples')
          AND table_catalog NOT LIKE '\\_\\_databricks\\_internal%'""",
        "system.information_schema.tables (monitor outputs)")
    mons: dict[str, dict[str, Any]] = {}

    def _entry(fqn: str, cat: str, sch: str, base: str) -> dict[str, Any]:
        return mons.setdefault(fqn, {
            "fqn": fqn, "catalog": cat, "schema": sch, "table": base,
            "has_profile": False, "has_drift": False, "owner": "",
            "last_refresh_hours": None, "freshness": "Unknown",
            "quality_status": None, "downstream": None,
        })

    for r in inv:
        cat, sch, t = str(r.get("c")), str(r.get("s")), str(r.get("t"))
        if t.endswith("_profile_metrics"):
            base = t[: -len("_profile_metrics")]
            kind = "has_profile"
        else:
            base = t[: -len("_drift_metrics")]
            kind = "has_drift"
        if not base:
            continue
        m = _entry(f"{cat}.{sch}.{base}", cat, sch, base)
        m[kind] = True
        m["owner"] = m["owner"] or str(r.get("owner") or "")
        hours = int(_f(r.get("hours_ago")))
        if m["last_refresh_hours"] is None or hours < m["last_refresh_hours"]:
            m["last_refresh_hours"] = hours

    for m in mons.values():
        h = m["last_refresh_hours"]
        if h is not None:
            m["freshness"] = "Fresh" if h <= 24 else "Stale"

    # Layer 3 — optional enrichment; missing grant must not darken the page.
    results_available = True
    try:
        res = _run(warehouse_id, """
            SELECT catalog_name AS c, schema_name AS s, table_name AS t, status,
                   freshness.status AS fstatus,
                   downstream_impact.num_downstream_tables AS downstream
            FROM system.data_quality_monitoring.table_results
            QUALIFY row_number() OVER (PARTITION BY catalog_name, schema_name, table_name
                                       ORDER BY event_time DESC) = 1""",
            "system.data_quality_monitoring")
    except LiveError:
        results_available = False
        res = []
    for r in res:
        cat, sch, t = str(r.get("c")), str(r.get("s")), str(r.get("t"))
        m = _entry(f"{cat}.{sch}.{t}", cat, sch, t)
        m["quality_status"] = _dq_quality(str(r.get("status")))
        m["downstream"] = int(_f(r.get("downstream")))
        if m["last_refresh_hours"] is None:
            m["freshness"] = _dq_freshness(str(r.get("fstatus")))

    monitors = sorted(mons.values(), key=lambda m: (
        {"Critical": 0, "Warning": 1}.get(m["quality_status"] or "", 2),
        0 if m["freshness"] == "Stale" else 1,
        m["fqn"]))

    cost = _run(warehouse_id,
        "SELECT CAST(u.workspace_id AS STRING) ws, SUM(u.usage_quantity) dbus, "
        "SUM(u.usage_quantity*lp.pricing.effective_list.default) usd FROM system.billing.usage u "
        "LEFT JOIN system.billing.list_prices lp ON u.cloud=lp.cloud AND u.sku_name=lp.sku_name "
        "AND u.usage_start_time>=lp.price_start_time AND (lp.price_end_time IS NULL OR u.usage_start_time<lp.price_end_time) "
        "WHERE u.billing_origin_product='DATA_QUALITY_MONITORING' AND u.usage_date>=date_trunc('MONTH',current_date()) "
        f"{_ws_scope_sql(warehouse_id)} GROUP BY 1 ORDER BY usd DESC", "system.billing.usage (DQM cost)")
    by_workspace = [{"workspace": str(r.get("ws")),
                     "cost_usd_month": round(_f(r.get("usd")), 2),
                     "dbus_month": round(_f(r.get("dbus")), 1)} for r in cost]
    total_cost = round(sum(w["cost_usd_month"] for w in by_workspace), 2)
    total_dbus = round(sum(w["dbus_month"] for w in by_workspace), 1)

    return {
        "monitors": monitors[:300],
        "summary": {
            "num_monitors": len(monitors), "num_visible": min(300, len(monitors)),
            "num_fresh": sum(1 for m in monitors if m["freshness"] == "Fresh"),
            "num_stale": sum(1 for m in monitors if m["freshness"] == "Stale"),
            "num_critical": sum(1 for m in monitors if m["quality_status"] == "Critical") if results_available else None,
            "num_warning": sum(1 for m in monitors if m["quality_status"] == "Warning") if results_available else None,
            "dqm_cost_usd_month": total_cost, "dqm_dbus_month": total_dbus,
            "results_available": results_available,
        },
        "by_workspace": by_workspace,
        "caveat": ("Monitors are discovered from their *_profile_metrics / *_drift_metrics output tables "
                   "(the ones you can see); last refresh = when the output table last changed. Monitoring "
                   "spend is the DATA_QUALITY_MONITORING billing line."
                   + ("" if results_available else
                      " Quality statuses need SELECT on system.data_quality_monitoring.table_results "
                      "(account-admin grant) — not held by your identity, so that column is absent.")),
    }
