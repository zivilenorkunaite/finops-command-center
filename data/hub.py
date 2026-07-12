"""Recommendations hub: findings COMPOSED from the other pages' cached
objects — one rec per insight×warehouse rather than per statement, plus the
cost-attribution rollup. No extra table scans of its own.
"""
from __future__ import annotations

from typing import Any
from data.advisor import queries_live
from data.cache import _cached_payload
from data.governance import _compute_hygiene
from data.runtime import LiveError, _f
from data.tables import _HMS_NEXT_STEPS
from data.workspaces import _workspace_facts


def hub_live(warehouse_id: str) -> dict[str, Any]:
    """Hub: recommendations derived from real query metrics plus the tagging
    gap, with the cost-attribution rollup."""
    qrows = [q for q in queries_live(warehouse_id, "7d") if q["insight_type"] not in (None, "", "none", "OK", "healthy")]
    gov = _cached_payload("governance", warehouse_id)
    recs = []
    # One rec per (insight type × warehouse), not one per statement — 40
    # near-identical "slow-query" rows are noise, a rollup is a finding.
    grouped: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for q in qrows:
        grouped.setdefault((str(q["insight_type"]), str(q["warehouse"])), []).append(q)
    for (itype, wh), qs in sorted(grouped.items(), key=lambda kv: -max(_f(x.get("p95_s")) for x in kv[1])):
        worst = max(qs, key=lambda x: _f(x.get("p95_s")))
        high = any(x["severity"] == "High" for x in qs)
        recs.append({
            "id": f"live-q-{itype}-{wh}",
            "category": "compute",
            "priority": "P2" if high else "P3",
            "priority_score": round(_f(worst.get("p95_s"))),
            "title": f"{len(qs)} {itype} statement{'s' if len(qs) != 1 else ''} — warehouse {wh}",
            "scope": "workspace", "scope_label": str(worst.get("workspace")),
            "effort": "Low",
            "evidence": [f"Worst p95 {round(_f(worst.get('p95_s')))}s across {sum(x['runs'] for x in qs)} runs. "
                         + str(worst["rationale"]),
                         "Details + AI advice per statement on the Query Advisor tab."],
            "what_to_do": worst.get("next_steps") or [],
            "owner": "FinOps", "workspace": worst.get("workspace"),
        })
    try:
        hms_tables = [t for t in _cached_payload("tables", warehouse_id) if t["catalog"] == "hive_metastore"]
    except LiveError:
        hms_tables = []
    if hms_tables:
        recs.insert(0, {
            "id": "live-hms", "category": "governance",
            "priority": "P1", "priority_score": 95,
            "title": f"{len(hms_tables)} legacy hive_metastore table{'s' if len(hms_tables) != 1 else ''} — migrate to Unity Catalog",
            "scope": "global", "scope_label": "Estate",
            "effort": "Med",
            "evidence": [
                "hive_metastore tables sit outside Unity Catalog governance: no lineage, no fine-grained grants, no system-table coverage.",
                "e.g. " + ", ".join(t["fqn"] for t in hms_tables[:5]),
            ],
            "what_to_do": list(_HMS_NEXT_STEPS),
            "owner": "Data Platform", "workspace": None,
        })
    # Estate-level findings from real billing shares (thresholds follow the
    # Databricks Well-Architected cost-optimisation guidance).
    facts = _workspace_facts(warehouse_id)
    dbus_total = sum(w["dbus_month"] for w in facts) or 1.0
    serverless_share = sum(w["serverless_share"] * w["dbus_month"] for w in facts) / dbus_total
    automated_share = sum(w["automated_pct"] * w["dbus_month"] for w in facts) / dbus_total
    if serverless_share < 0.6:
        recs.append({
            "id": "live-waf-serverless", "category": "compute",
            "priority": "P2", "priority_score": 70,
            "title": f"Serverless is only {round(serverless_share*100)}% of usage — grow it",
            "scope": "global", "scope_label": "Estate",
            "effort": "Med",
            "evidence": [f"{round(serverless_share*100)}% of month-to-date DBUs run serverless (sku_name in system.billing.usage); classic compute idles between workloads and needs manual sizing."],
            "what_to_do": ["Default new SQL workloads to serverless warehouses", "Move eligible jobs to serverless job compute"],
            "owner": "Data Platform", "workspace": None,
        })
    if automated_share < 0.25:
        recs.append({
            "id": "live-waf-jobs", "category": "compute",
            "priority": "P2", "priority_score": 65,
            "title": f"Only {round(automated_share*100)}% of usage runs as jobs",
            "scope": "global", "scope_label": "Estate",
            "effort": "Med",
            "evidence": [f"{round(automated_share*100)}% of month-to-date DBUs are JOBS/DLT; the rest is interactive compute, which bills at a higher rate and idles between commands."],
            "what_to_do": ["Move recurring interactive workloads onto scheduled jobs", "Use job clusters that terminate on completion"],
            "owner": "Data Platform", "workspace": None,
        })
    try:
        hyg = _compute_hygiene(warehouse_id)
    except LiveError:
        hyg = {"never_stop_warehouses": [], "no_autoterm_clusters": []}
    if hyg["never_stop_warehouses"]:
        names = ", ".join(w["name"] for w in hyg["never_stop_warehouses"][:5])
        recs.append({
            "id": "live-wh-autostop", "category": "compute",
            "priority": "P2", "priority_score": 75,
            "title": f"{len(hyg['never_stop_warehouses'])} SQL warehouse(s) never auto-stop",
            "scope": "global", "scope_label": "Estate",
            "effort": "Low",
            "evidence": [f"auto_stop_minutes = 0 in system.compute.warehouses: {names}. An idle warehouse that never stops bills continuously."],
            "what_to_do": ["Set a 10–15 minute auto-stop window on each", "Prefer serverless warehouses, which manage idle capacity automatically"],
            "owner": "Data Platform", "workspace": None,
        })
    if hyg["no_autoterm_clusters"]:
        names = ", ".join(hyg["no_autoterm_clusters"][:5])
        recs.append({
            "id": "live-cluster-autoterm", "category": "compute",
            "priority": "P2", "priority_score": 72,
            "title": f"{len(hyg['no_autoterm_clusters'])} cluster(s) without auto-termination",
            "scope": "global", "scope_label": "Estate",
            "effort": "Low",
            "evidence": [f"auto_termination_minutes unset/0 in system.compute.clusters: {names}. A forgotten all-purpose cluster bills until someone notices."],
            "what_to_do": ["Set auto-termination (30–60 min) on each", "Enforce it estate-wide with a cluster policy"],
            "owner": "Data Platform", "workspace": None,
        })
    if gov["untagged_pct"] > 0.2:
        recs.insert(0, {
            "id": "live-tagging", "category": "tagging",
            "priority": "P1", "priority_score": 100,
            "title": f"{round(gov['untagged_pct']*100)}% of spend is untagged",
            "scope": "global", "scope_label": "Estate",
            "effort": "Med",
            "evidence": [f"${gov['untagged_usd_month']:,}/mo has no cost-attribution tags (system.billing.usage.custom_tags)."],
            "what_to_do": ["Mandate cost-center tags via compute policies", "Backfill tags on the top 10 warehouses/jobs"],
            "owner": "FinOps", "workspace": None,
        })
    pr = {"P1": 0, "P2": 0, "P3": 0}
    cat_counts: dict[str, int] = {}
    for r in recs:
        pr[r["priority"]] = pr.get(r["priority"], 0) + 1
        cat_counts[r["category"]] = cat_counts.get(r["category"], 0) + 1
    summary = {
        "num_recs": len(recs), "num_p1": pr["P1"], "num_p2": pr["P2"], "num_p3": pr["P3"],
        "priority_counts": pr,
        "untagged_spend_usd_month": gov["untagged_usd_month"],
        "untagged_pct": gov["untagged_pct"],
        "top_category": max(cat_counts, key=cat_counts.get) if cat_counts else None,
        "category_counts": cat_counts,
    }
    drivers_payload = _cached_payload("cost_drivers", warehouse_id)
    attribution = {
        "total_spend_usd_month": round(sum(w["spend_usd_month"] for w in facts)),
        "total_untagged_usd_month": gov["untagged_usd_month"],
        "untagged_pct": gov["untagged_pct"],
        "by_workspace": gov["tagging_by_workspace"],
        "cost_drivers": (drivers_payload.get("drivers") or [])[:10],
        "driver_spikes": [m for m in (drivers_payload.get("mom") or [])
                          if _f(m.get("mom_pct")) > 0.25 and _f(m.get("delta_usd")) > 100][:8],
    }
    return {"recommendations": recs, "summary": summary, "attribution": attribution}
