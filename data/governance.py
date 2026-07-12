"""Governance scorecard: tag coverage, UC adoption, serverless/jobs share,
compute hygiene from system.compute, and the access risk tie-in — tiles
reuse the cached workspace facts, table inventory and grants so every tab
shows the same numbers.
"""
from __future__ import annotations

from typing import Any
from data.access import risks_from
from data.cache import _cached_payload
from data.runtime import LiveError, _f, _run
from data.store import _untagged_pred, _ws_scope_sql
from data.workspaces import _workspace_facts


def _gov_tile(category: str, metric: str, pct: float, good: float, warn: float,
              action: str, ties_to: str) -> dict[str, Any]:
    status = "Good" if pct >= good else ("Warning" if pct >= warn else "Critical")
    points = {"Good": 10, "Warning": 5, "Critical": 0}[status]
    return {
        "category": category, "metric": metric, "value_pct": round(pct, 3),
        "status": status, "score_points": points, "weight": 1,
        "gap": f"{round((1 - pct) * 100)}% remaining", "action": action, "ties_to": ties_to,
    }


def _compute_hygiene(warehouse_id: str) -> dict[str, Any]:
    """Compute-config waste checks from the SCD inventory tables (latest row
    per object, live objects only, scoped): SQL warehouses that never
    auto-stop, and non-job clusters without auto-termination. Both bill while
    idle — classic Well-Architected cost hygiene."""
    wsf = _ws_scope_sql(warehouse_id, "workspace_id")
    never_stop = _run(warehouse_id, f"""
        SELECT warehouse_name, warehouse_size
        FROM (SELECT warehouse_id,
                     MAX_BY(warehouse_name, change_time) AS warehouse_name,
                     MAX_BY(warehouse_size, change_time) AS warehouse_size,
                     MAX_BY(auto_stop_minutes, change_time) AS auto_stop_minutes,
                     MAX_BY(delete_time, change_time) AS delete_time
              FROM system.compute.warehouses
              WHERE 1=1{wsf}
              GROUP BY warehouse_id)
        WHERE delete_time IS NULL AND auto_stop_minutes = 0
        ORDER BY warehouse_name LIMIT 50""", "system.compute.warehouses")
    no_autoterm = _run(warehouse_id, f"""
        SELECT cluster_name
        FROM (SELECT cluster_id,
                     MAX_BY(cluster_name, change_time) AS cluster_name,
                     MAX_BY(auto_termination_minutes, change_time) AS auto_termination_minutes,
                     MAX_BY(cluster_source, change_time) AS cluster_source,
                     MAX_BY(delete_time, change_time) AS delete_time
              FROM system.compute.clusters
              WHERE 1=1{wsf}
              GROUP BY cluster_id)
        WHERE delete_time IS NULL
          AND cluster_source NOT IN ('JOB', 'PIPELINE', 'PIPELINE_MAINTENANCE')
          AND (auto_termination_minutes IS NULL OR auto_termination_minutes = 0)
        ORDER BY cluster_name LIMIT 50""", "system.compute.clusters")
    return {
        "never_stop_warehouses": [
            {"name": str(r.get("warehouse_name") or ""), "size": str(r.get("warehouse_size") or "")}
            for r in never_stop],
        "no_autoterm_clusters": [str(r.get("cluster_name") or "") for r in no_autoterm],
    }


def governance_live(warehouse_id: str) -> dict[str, Any]:
    # Same canonical price join as every other billing read (cloud + sku +
    # time-validity, effective list price), month-to-date like the rest of
    # the app's "/ mo" figures.
    tag_rows = _run(warehouse_id, f"""
        SELECT u.workspace_id AS ws,
               SUM(CASE WHEN {_untagged_pred(warehouse_id, 'u.custom_tags')}
                        THEN u.usage_quantity * lp.pricing.effective_list.default ELSE 0 END) AS untagged_usd,
               SUM(u.usage_quantity * lp.pricing.effective_list.default) AS total_usd
        FROM system.billing.usage u
        LEFT JOIN system.billing.list_prices lp ON u.cloud = lp.cloud AND u.sku_name = lp.sku_name
         AND u.usage_start_time >= lp.price_start_time
         AND (lp.price_end_time IS NULL OR u.usage_start_time < lp.price_end_time)
        WHERE u.usage_date >= date_trunc('MONTH', current_date()){_ws_scope_sql(warehouse_id)}
        GROUP BY u.workspace_id""", "system.billing.usage (tags)")
    total = sum(_f(r.get("total_usd")) for r in tag_rows)
    untagged = sum(_f(r.get("untagged_usd")) for r in tag_rows)
    tagged_pct = (1 - untagged / total) if total else 0.0

    def _tag_status(pct: float) -> str:
        return "Good" if pct >= 0.8 else ("Warning" if pct >= 0.5 else "Critical")

    by_ws = []
    for r in sorted(tag_rows, key=lambda r: -_f(r.get("total_usd")))[:20]:
        ws_total = _f(r.get("total_usd"))
        ws_untagged = _f(r.get("untagged_usd"))
        pct_tagged = (1 - ws_untagged / ws_total) if ws_total else 1.0
        by_ws.append({
            "workspace": str(r.get("ws") or ""),
            "spend_usd_month": round(ws_total),
            "untagged_usd_month": round(ws_untagged),
            "untagged_pct": round(1 - pct_tagged, 3),
            "tagging_pct": round(pct_tagged, 3),
            "status": _tag_status(pct_tagged),
        })

    facts = _workspace_facts(warehouse_id)
    spend = sum(w["spend_usd_month"] for w in facts) or 1.0
    serverless = sum(w["serverless_share"] * w["spend_usd_month"] for w in facts) / spend
    automated = sum(w["automated_pct"] * w["spend_usd_month"] for w in facts) / spend

    # ties_to values are REAL page ids — the tile's arrow navigates there.
    tiles = [
        _gov_tile("tagging", "Tagged spend (cost attribution)", tagged_pct, 0.8, 0.5,
                  "Enforce cost-center / project tags via cluster & warehouse policies.",
                  "tags"),
    ]
    try:
        tbls = _cached_payload("tables", warehouse_id)
        hms = sum(1 for t in tbls if t["catalog"] == "hive_metastore")
        uc_pct = ((len(tbls) - hms) / len(tbls)) if tbls else 1.0
        tiles.append(_gov_tile(
            "governance", "Unity Catalog adoption (tables)", uc_pct, 0.999, 0.9,
            f"Migrate the {hms} legacy hive_metastore table(s) to Unity Catalog (CTAS or SYNC)."
            if hms else "All inventoried tables are Unity Catalog governed.", "tables"))
    except LiveError:
        pass  # tables read failed — score the remaining tiles only
    tiles += [
        _gov_tile("compute", "Serverless share of spend", serverless, 0.6, 0.3,
                  "Prefer serverless SQL/jobs where in-region availability allows.", "workspaces"),
        _gov_tile("automation", "Automated (jobs) share of usage", automated, 0.6, 0.25,
                  "Move recurring interactive workloads onto scheduled jobs.", "workspaces"),
    ]
    # Access posture: critical risk flags over direct UC grants (same engine
    # as the Access page) — a count tile, not a percentage.
    try:
        crit = sum(1 for r in risks_from(_cached_payload("grants", warehouse_id))
                   if r.get("severity") == "critical")
        a_status = "Good" if crit == 0 else ("Warning" if crit <= 3 else "Critical")
        tiles.append({
            "category": "access", "metric": "Critical access risk flags",
            "value_count": crit, "status": a_status,
            "score_points": {"Good": 10, "Warning": 5, "Critical": 0}[a_status],
            "weight": 1,
            "gap": ("none open" if crit == 0 else f"{crit} critical flag(s) open"),
            "action": "Review ALL PRIVILEGES / MANAGE grants to all-users groups on the Access page.",
            "ties_to": "access",
        })
    except LiveError:
        pass
    # Compute-config hygiene (idle compute bills until stopped).
    try:
        hyg = _compute_hygiene(warehouse_id)
        for cid, metric, items, action in (
            ("compute", "Warehouses without auto-stop",
             [f"{w['name']} ({w['size']})" for w in hyg["never_stop_warehouses"]],
             "Set an auto-stop window on these SQL warehouses — they bill until stopped manually."),
            ("compute", "Clusters without auto-termination",
             hyg["no_autoterm_clusters"],
             "Set auto-termination on these all-purpose clusters — forgotten clusters bill until someone notices."),
        ):
            n = len(items)
            status = "Good" if n == 0 else ("Warning" if n <= 2 else "Critical")
            tiles.append({
                "category": cid, "metric": metric,
                "value_count": n, "status": status,
                "score_points": {"Good": 10, "Warning": 5, "Critical": 0}[status],
                "weight": 1,
                "gap": ("none found" if n == 0 else "e.g. " + ", ".join(items[:3])),
                "action": action, "ties_to": "workspaces",
            })
    except LiveError:
        pass  # compute inventory not readable — score the remaining tiles

    counts = {"Good": 0, "Warning": 0, "Critical": 0}
    for t in tiles:
        counts[t["status"]] += 1
    score = round(sum(t["score_points"] for t in tiles) / (len(tiles) * 10) * 100)
    grade = "A" if score >= 85 else ("B" if score >= 65 else ("C" if score >= 40 else "D"))
    return {"score": score, "grade": grade, "counts": counts, "num_tiles": len(tiles),
            "tiles": tiles, "tagging_by_workspace": by_ws,
            "untagged_usd_month": round(untagged), "untagged_pct": round(1 - tagged_pct, 3)}
