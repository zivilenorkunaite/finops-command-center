"""Workspaces + Overview: per-workspace billing facts with deterministic
BEST-PRACTICE CHECKS (Well-Architected cost guidance) — health is the worst
applicable check, complexity comes from the measured serverless/interactive
mix, and every drill-down figure is real billing dollars. Also the stored
workspace universe (Configuration pick-list) and the platform spend total
that Overview, Genie $ and AI $ all share (one source, no drift).
"""
from __future__ import annotations

import re
import time
from typing import Any
from data.drivers import cost_drivers_live
from data.runtime import LiveError, _MEMO, _f, _run, _ttl_cache
from data.store import _pg_ensure, _pg_exec, _schema_fqn, _store_is_lakebase, _untagged_pred, _ws_scope_sql


def platform_spend_total(warehouse_id: str) -> float:
    """Total platform spend this month (scoped) — for the '% of total spend'
    context on the Genie/AI pages. Summed from the same per-workspace facts
    the Overview shows, so the two figures always agree."""
    return round(float(sum(w["spend_usd_month"] for w in _workspace_facts(warehouse_id))), 2)


# ---------------------------------------------------------------------------
# Workspaces + Overview — per-workspace billing facts with BEST-PRACTICE
# CHECKS (Well-Architected cost guidance), each applied only where it is
# relevant to the workspace's workload mix. Health = worst applicable check —
# NOT the automation share alone (a serving-heavy workspace legitimately runs
# 0% jobs). No modelled savings dollars. Non-billing detail (BU, idle %,
# sparkline) is left blank rather than faked.
# ---------------------------------------------------------------------------
def _ws_checks(usd: float, usd_run_rate: float, usd_prev: float,
               tagged_pct: float, serverless: float,
               jobs_share: float | None, classic_share: float) -> list[dict[str, Any]]:
    """Deterministic per-workspace checks. Status pass/warn/fail — or n/a
    when the check does not apply to this workspace's mix."""
    checks: list[dict[str, Any]] = []

    def add(cid: str, label: str, status: str, detail: str) -> None:
        checks.append({"id": cid, "label": label, "status": status, "detail": detail})

    st = "pass" if tagged_pct >= 0.8 else ("warn" if tagged_pct >= 0.5 else "fail")
    add("tagging", "Cost-attribution tags", st,
        f"{round(tagged_pct * 100)}% of this month's spend carries custom tags (target ≥80%)")

    st = "pass" if serverless >= 0.6 else ("warn" if serverless >= 0.3 else "fail")
    add("serverless", "Serverless share", st,
        f"{round(serverless * 100)}% of DBUs run serverless (target ≥60%; serverless scales to zero)")

    if jobs_share is None:
        add("jobs", "Jobs over interactive compute", "n/a",
            f"Only {round(classic_share * 100)}% of DBUs are classic jobs/interactive compute — check not applicable to this mix")
    else:
        st = "pass" if jobs_share >= 0.6 else ("warn" if jobs_share >= 0.25 else "fail")
        add("jobs", "Jobs over interactive compute", st,
            f"{round(jobs_share * 100)}% of classic compute runs as jobs/DLT rather than interactive (target ≥60%)")

    if usd_prev >= 100:
        growth = (usd_run_rate - usd_prev) / usd_prev
        st = "pass" if growth <= 0.25 else ("warn" if growth <= 0.75 else "fail")
        add("spend", "Spend trajectory", st,
            f"Run-rate {'+' if growth >= 0 else ''}{round(growth * 100)}% vs last month "
            f"(${round(usd_run_rate):,} projected vs ${round(usd_prev):,})")
    else:
        add("spend", "Spend trajectory", "n/a",
            "No meaningful spend last month to compare against")
    return checks


def _ws_health(checks: list[dict[str, Any]]) -> str:
    """Worst applicable check wins: any fail → Critical, any warn → Warning."""
    statuses = [c["status"] for c in checks if c["status"] != "n/a"]
    if "fail" in statuses:
        return "Critical"
    if "warn" in statuses:
        return "Warning"
    return "Good"


def _opt_complexity(serverless: float, interactive_share: float) -> str:
    """How much work optimising this workspace takes. Easy: already mostly
    serverless with almost no interactive classic compute (incremental
    tuning). Hard: mostly classic compute with a heavy interactive share
    (structural migration). Medium: in between."""
    if serverless >= 0.6 and interactive_share <= 0.10:
        return "Easy"
    if serverless < 0.3 and interactive_share > 0.4:
        return "Hard"
    return "Medium"


@_ttl_cache(600)
def _workspace_facts(warehouse_id: str, include_scope: bool = True) -> list[dict[str, Any]]:
    """Per-workspace billing facts + best-practice checks. Scans the current
    AND previous month in one pass (the spend-trajectory check compares the
    current run-rate to last month)."""
    wsf = _ws_scope_sql(warehouse_id) if include_scope else ""
    rows = _run(warehouse_id,
        "WITH w AS (SELECT u.*, lp.pricing.effective_list.default AS px, "
        "  u.usage_date >= date_trunc('MONTH', current_date()) AS cur "
        "FROM system.billing.usage u "
        "LEFT JOIN system.billing.list_prices lp ON u.cloud=lp.cloud AND u.sku_name=lp.sku_name "
        "AND u.usage_start_time>=lp.price_start_time AND (lp.price_end_time IS NULL OR u.usage_start_time<lp.price_end_time) "
        f"WHERE u.usage_date >= add_months(date_trunc('MONTH', current_date()), -1){wsf}) "
        "SELECT CAST(workspace_id AS STRING) ws, "
        "SUM(CASE WHEN cur THEN usage_quantity ELSE 0 END) dbus, "
        "SUM(CASE WHEN cur THEN usage_quantity*px ELSE 0 END) usd, "
        "SUM(CASE WHEN NOT cur THEN usage_quantity*px ELSE 0 END) usd_prev, "
        "SUM(CASE WHEN cur AND sku_name ILIKE '%SERVERLESS%' THEN usage_quantity ELSE 0 END) sl_dbus, "
        "SUM(CASE WHEN cur AND billing_origin_product IN ('JOBS','DLT') THEN usage_quantity ELSE 0 END) auto_dbus, "
        "SUM(CASE WHEN cur AND billing_origin_product IN ('INTERACTIVE','ALL_PURPOSE') THEN usage_quantity ELSE 0 END) inter_dbus, "
        f"SUM(CASE WHEN cur AND {_untagged_pred(warehouse_id, 'custom_tags')} THEN usage_quantity*px ELSE 0 END) untagged_usd, "
        "COUNT(DISTINCT CASE WHEN cur THEN usage_metadata.cluster_id END) clusters, "
        "COUNT(DISTINCT CASE WHEN cur THEN usage_metadata.warehouse_id END) whs "
        "FROM w GROUP BY 1 HAVING SUM(CASE WHEN cur THEN usage_quantity ELSE 0 END) > 0",
        "system.billing.usage (workspaces)")
    # Run-rate projection factor: scale month-to-date spend to a full month.
    day_of_month = max(1, int(time.strftime("%d", time.gmtime())))
    days_in_month = 30.4
    project = days_in_month / day_of_month
    out: list[dict[str, Any]] = []
    for r in rows:
        dbus = _f(r.get("dbus")); usd = _f(r.get("usd")); usd_prev = _f(r.get("usd_prev"))
        serverless = (_f(r.get("sl_dbus")) / dbus) if dbus else 0.0
        automated = (_f(r.get("auto_dbus")) / dbus) if dbus else 0.0
        interactive = (_f(r.get("inter_dbus")) / dbus) if dbus else 0.0
        classic = _f(r.get("auto_dbus")) + _f(r.get("inter_dbus"))
        classic_share = classic / dbus if dbus else 0.0
        jobs_share = (_f(r.get("auto_dbus")) / classic) if classic_share >= 0.05 and classic else None
        tagged_pct = (1 - _f(r.get("untagged_usd")) / usd) if usd else 1.0
        checks = _ws_checks(usd, usd * project, usd_prev, tagged_pct, serverless,
                            jobs_share, classic_share)
        growth = ((usd * project - usd_prev) / usd_prev) if usd_prev >= 100 else None
        out.append({
            "workspace_id": str(r.get("ws")), "workspace": str(r.get("ws")),
            "spend_usd_month": round(usd),
            "mom_pct": round(growth, 3) if growth is not None else None,
            "tagged_pct": round(tagged_pct, 3),
            "automated_pct": round(automated, 3),
            "interactive_share": round(interactive, 3),
            "jobs_share": round(jobs_share, 3) if jobs_share is not None else None,
            "serverless_share": round(serverless, 3),
            "health": _ws_health(checks),
            "checks": checks,
            "complexity": _opt_complexity(serverless, interactive),
            "dbus_month": round(dbus), "num_clusters": int(_f(r.get("clusters"))),
            "num_warehouses": int(_f(r.get("whs"))),
        })
    out.sort(key=lambda w: -w["spend_usd_month"])
    return out


def _universe_table_fqn() -> str:
    return f"{_schema_fqn()}.workspace_universe"


def refresh_workspace_universe(warehouse_id: str) -> None:
    """Rebuild the stored workspace pick-list. The month-wide billing scan
    runs as the VIEWER (UNSCOPED on purpose — the picker must show
    everything); the result is stored as the APP. Triggered by the Admin
    page's Refresh button and by the first-ever load."""
    scan = _run(warehouse_id, """
        SELECT CAST(u.workspace_id AS STRING) AS workspace_id,
               ROUND(SUM(u.usage_quantity*lp.pricing.effective_list.default)) AS spend_usd_month,
               ROUND(SUM(u.usage_quantity)) AS dbus_month
        FROM system.billing.usage u
        LEFT JOIN system.billing.list_prices lp ON u.cloud=lp.cloud AND u.sku_name=lp.sku_name
         AND u.usage_start_time>=lp.price_start_time AND (lp.price_end_time IS NULL OR u.usage_start_time<lp.price_end_time)
        WHERE u.usage_date>=date_trunc('MONTH',current_date())
        GROUP BY 1 HAVING SUM(u.usage_quantity)>0""", "system.billing.usage (universe scan)")
    now = time.strftime("%Y-%m-%d %H:%M:%S+00", time.gmtime())
    rows = [(str(r.get("workspace_id") or ""), _f(r.get("spend_usd_month")),
             _f(r.get("dbus_month")), now) for r in scan if r.get("workspace_id")]
    if _store_is_lakebase():
        _pg_ensure()
        _pg_exec("TRUNCATE TABLE workspace_universe", source="workspace_universe")
        _pg_exec("INSERT INTO workspace_universe (workspace_id, spend_usd_month, dbus_month, computed_at) "
                 "VALUES (%s, %s, %s, %s)", rows, many=True, source="workspace_universe")
    else:
        _run(warehouse_id, f"CREATE SCHEMA IF NOT EXISTS {_schema_fqn()}", "app schema", as_app=True)
        _run(warehouse_id, f"""
            CREATE OR REPLACE TABLE {_universe_table_fqn()} (
              workspace_id STRING, spend_usd_month DOUBLE, dbus_month DOUBLE,
              computed_at TIMESTAMP)""", "workspace_universe", as_app=True)
        for i in range(0, len(rows), 1000):
            values = ",".join(
                f"('{ws}',{spend},{dbus},TIMESTAMP'{now}')"
                for ws, spend, dbus, _ in rows[i:i + 1000]
                if re.fullmatch(r"[0-9]{1,20}", ws))
            if values:
                _run(warehouse_id, f"INSERT INTO {_universe_table_fqn()} VALUES {values}",
                     "workspace_universe", as_app=True)
    for k in [k for k in _MEMO if k.startswith("workspace_universe")]:
        _MEMO.pop(k, None)


@_ttl_cache(60)
def workspace_universe(warehouse_id: str) -> dict[str, Any]:
    """The STORED workspace pick-list {rows, computed_at} — a cheap app-store
    read, not a billing scan. Auto-builds once when the table is empty."""
    for attempt in (1, 2):
        try:
            if _store_is_lakebase():
                _pg_ensure()
                rows = _pg_exec(
                    "SELECT workspace_id, spend_usd_month, dbus_month, "
                    "CAST(computed_at AS text) AS computed_at "
                    "FROM workspace_universe ORDER BY spend_usd_month DESC",
                    fetch=True, source="workspace_universe")
            else:
                rows = _run(warehouse_id,
                            f"SELECT workspace_id, spend_usd_month, dbus_month, "
                            f"CAST(computed_at AS STRING) AS computed_at "
                            f"FROM {_universe_table_fqn()} ORDER BY spend_usd_month DESC",
                            "workspace_universe", as_app=True)
            if rows:
                return {
                    "rows": [{"workspace_id": str(r.get("workspace_id")),
                              "spend_usd_month": _f(r.get("spend_usd_month")),
                              "dbus_month": _f(r.get("dbus_month"))} for r in rows],
                    "computed_at": str(rows[0].get("computed_at") or ""),
                }
        except LiveError:
            pass
        if attempt == 1:
            refresh_workspace_universe(warehouse_id)
    return {"rows": [], "computed_at": ""}


def workspaces_live(warehouse_id: str, workspace: str | None = None) -> list[dict[str, Any]]:
    facts = _workspace_facts(warehouse_id)
    scoped = None if not workspace or workspace in ("all", "") else workspace
    return [w for w in facts if not scoped or scoped in (w["workspace"], w.get("workspace_id"))]


def overview_live(warehouse_id: str) -> dict[str, Any]:
    """Estate rollup from the per-workspace facts + weekly spend trend + the
    live cost-driver breakdown."""
    facts = _workspace_facts(warehouse_id)
    total_spend = sum(w["spend_usd_month"] for w in facts)
    total_dbus = sum(w["dbus_month"] for w in facts)

    weekly = _run(warehouse_id,
        "SELECT date_format(date_trunc('WEEK',u.usage_date),'yyyy-MM-dd') wk, "
        "SUM(u.usage_quantity*lp.pricing.effective_list.default) usd FROM system.billing.usage u "
        "LEFT JOIN system.billing.list_prices lp ON u.cloud=lp.cloud AND u.sku_name=lp.sku_name "
        "AND u.usage_start_time>=lp.price_start_time AND (lp.price_end_time IS NULL OR u.usage_start_time<lp.price_end_time) "
        f"WHERE u.usage_date>=dateadd(WEEK,-11,current_date()){_ws_scope_sql(warehouse_id)} GROUP BY 1 ORDER BY 1",
        "system.billing.usage (weekly trend)")
    # "Captured savings" is not measurable from system tables — the only honest
    # weekly series is spend. savings_usd: None ⇒ the chart drops that series
    # (never chart spend × estimated-% as if it were realised savings).
    trend = [{"week": str(r.get("wk")), "spend_usd": round(_f(r.get("usd"))),
              "savings_usd": None} for r in weekly]

    # Top opportunities = the worst applicable best-practice check per
    # workspace, biggest spenders first. Workspaces passing everything are
    # not "opportunities" and are skipped.
    top_opportunities = []
    for w in sorted(facts, key=lambda x: -x["spend_usd_month"]):
        worst = next((c for c in w["checks"] if c["status"] == "fail"),
                     next((c for c in w["checks"] if c["status"] == "warn"), None))
        if not worst:
            continue
        top_opportunities.append({
            "type": "workspace", "insight": worst["label"], "target": w["workspace"],
            "detail": worst["detail"], "est_savings_usd_month": None})
        if len(top_opportunities) >= 8:
            break

    return {
        "total_spend_usd_month": round(total_spend),
        "total_dbus_month": round(total_dbus),
        "num_workspaces": len(facts),
        "num_critical": sum(1 for w in facts if w["health"] == "Critical"),
        # Optimisation-complexity mix (see _opt_complexity).
        "opt_easy": sum(1 for w in facts if w["complexity"] == "Easy"),
        "opt_medium": sum(1 for w in facts if w["complexity"] == "Medium"),
        "opt_hard": sum(1 for w in facts if w["complexity"] == "Hard"),
        "trend": trend,
        "top_opportunities": top_opportunities,
        "cost_drivers": cost_drivers_live(warehouse_id, None),
    }


@_ttl_cache(600)
def workspace_detail_live(warehouse_id: str, workspace_id: str) -> dict[str, Any] | None:
    facts = _workspace_facts(warehouse_id)
    row = next((w for w in facts if w.get("workspace_id") == workspace_id
                or w.get("workspace") == workspace_id), None)
    if row is None:
        return None
    ws = row.get("workspace_id") or workspace_id
    # Canonical price join (cloud + sku + time validity, effective list),
    # same as every other billing read.
    price_join = """
        LEFT JOIN system.billing.list_prices lp ON u.cloud = lp.cloud AND u.sku_name = lp.sku_name
         AND u.usage_start_time >= lp.price_start_time
         AND (lp.price_end_time IS NULL OR u.usage_start_time < lp.price_end_time)"""
    monthly = _run(warehouse_id, f"""
        SELECT date_format(u.usage_date, 'yyyy-MM') AS month,
               SUM(u.usage_quantity * lp.pricing.effective_list.default) AS spend_usd
        FROM system.billing.usage u{price_join}
        WHERE u.usage_date >= add_months(date_trunc('MONTH', current_date()), -12) AND u.workspace_id = '{ws}'
        GROUP BY 1 ORDER BY 1""", "system.billing.usage (monthly trend)")
    # Top-by-$ lists come from BILLING (identity run_as / job / warehouse) so
    # the dollars are real — the UI ranks by spend, not run counts.
    users = _run(warehouse_id, f"""
        SELECT u.identity_metadata.run_as AS u,
               SUM(u.usage_quantity * lp.pricing.effective_list.default) AS usd
        FROM system.billing.usage u{price_join}
        WHERE u.usage_date >= date_trunc('MONTH', current_date()) AND u.workspace_id = '{ws}'
          AND u.identity_metadata.run_as IS NOT NULL
        GROUP BY 1 ORDER BY usd DESC LIMIT 5""", "system.billing.usage (top users)")
    jobs = _run(warehouse_id, f"""
        SELECT CAST(u.usage_metadata.job_id AS STRING) AS j,
               SUM(u.usage_quantity * lp.pricing.effective_list.default) AS usd
        FROM system.billing.usage u{price_join}
        WHERE u.usage_date >= date_trunc('MONTH', current_date()) AND u.workspace_id = '{ws}'
          AND u.usage_metadata.job_id IS NOT NULL
        GROUP BY 1 ORDER BY usd DESC LIMIT 5""", "system.billing.usage (top jobs)")
    whs = _run(warehouse_id, f"""
        SELECT u.usage_metadata.warehouse_id AS w,
               SUM(u.usage_quantity * lp.pricing.effective_list.default) AS usd
        FROM system.billing.usage u{price_join}
        WHERE u.usage_date >= date_trunc('MONTH', current_date()) AND u.workspace_id = '{ws}'
          AND u.usage_metadata.warehouse_id IS NOT NULL
        GROUP BY 1 ORDER BY usd DESC LIMIT 5""", "system.billing.usage (top warehouses)")
    try:
        drivers = cost_drivers_live(warehouse_id, ws)
    except LiveError:
        drivers = None
    return {
        **row,
        "monthly_trend": [{"month": r.get("month"), "spend_usd": round(_f(r.get("spend_usd")))} for r in monthly],
        "top_users": [{"user": r.get("u"), "spend_usd_month": round(_f(r.get("usd")), 2)} for r in users],
        "top_warehouses": [{"warehouse": r.get("w"), "spend_usd_month": round(_f(r.get("usd")), 2)} for r in whs],
        "top_jobs": [{"job": r.get("j"), "spend_usd_month": round(_f(r.get("usd")), 2)} for r in jobs],
        # The mix chart expects {product, pct, spend} — map from the drivers
        # payload shape ({label, pct_of_total, …}); passing it raw renders
        # blank names and NaN%.
        "product_mix": [
            {"product": d["label"], "pct": d["pct_of_total"],
             "spend_usd_month": d["spend_usd_month"]}
            for d in (drivers or {}).get("drivers", [])
        ],
        "cost_drivers": drivers,
    }
