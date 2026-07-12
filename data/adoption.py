"""Adoption & Value: who actually uses the platform — active identities from
billing, activity from query history, product breadth per workspace, and
the value map (lineage reads × freshness) over the curated tables.
"""
from __future__ import annotations

import time
from typing import Any
from data.cache import _cached_payload
from data.runtime import LiveError, _f, _run
from data.store import _ws_scope_sql


# AI-family products for the "AI adopters" count (Genie is counted on its own).
_AI_PRODUCTS = "('MODEL_SERVING','AI_FUNCTIONS','VECTOR_SEARCH','AGENT_BRICKS','FOUNDATION_MODEL_TRAINING','AI_GATEWAY')"


def adoption_live(warehouse_id: str) -> dict[str, Any]:
    """Adoption & value — who uses the platform and how broadly, all measured:
    active identities (billing run_as ∪ query.history executed_by — serverless
    SQL bills run_as as NULL), per-workspace product adoption from
    billing_origin_product, and a table value map from real reads
    (system.access.table_lineage) × freshness (information_schema)."""
    wsf = _ws_scope_sql(warehouse_id)
    qsf = _ws_scope_sql(warehouse_id, "q.workspace_id")

    ident = _run(warehouse_id, f"""
        SELECT u.identity_metadata.run_as AS who,
               MAX(u.usage_date) AS last_day,
               COUNT(DISTINCT CASE WHEN u.billing_origin_product = 'GENIE' THEN u.usage_date END) > 0 AS genie,
               COUNT(DISTINCT CASE WHEN u.billing_origin_product IN {_AI_PRODUCTS} THEN u.usage_date END) > 0 AS ai
        FROM system.billing.usage u
        WHERE u.usage_date >= dateadd(DAY, -30, current_date())
          AND u.identity_metadata.run_as IS NOT NULL{wsf}
        GROUP BY 1""", "system.billing.usage (identities)")
    q_users = _run(warehouse_id, f"""
        SELECT q.executed_by AS who, CAST(MAX(q.start_time) AS DATE) AS last_day
        FROM system.query.history q
        WHERE q.start_time >= dateadd(DAY, -30, current_timestamp()){qsf}
        GROUP BY 1""", "system.query.history (active users)")
    week_ago = time.strftime("%Y-%m-%d", time.gmtime(time.time() - 7 * 86400))
    last_by_user: dict[str, str] = {}
    for r in list(ident) + list(q_users):
        who, day = str(r.get("who") or ""), str(r.get("last_day") or "")
        if who and day > last_by_user.get(who, ""):
            last_by_user[who] = day
    mau = len(last_by_user)
    wau = sum(1 for d in last_by_user.values() if d >= week_ago)
    genie_users = sum(1 for r in ident if str(r.get("genie")).lower() == "true")
    ai_users = sum(1 for r in ident if str(r.get("ai")).lower() == "true")

    qcount = _run(warehouse_id, f"""
        SELECT COUNT(*) AS n FROM system.query.history q
        WHERE q.start_time >= dateadd(DAY, -30, current_timestamp()){qsf}""",
        "system.query.history (query count)")
    queries_month = int(_f(qcount[0].get("n"))) if qcount else 0

    top_users = [{
        "user": str(r.get("who") or ""),
        "workspace": str(r.get("ws") or ""),
        "queries_30d": int(_f(r.get("n"))),
        "last_active": str(r.get("last_active") or "")[:10],
    } for r in _run(warehouse_id, f"""
        SELECT q.executed_by AS who, CAST(max_by(q.workspace_id, q.start_time) AS STRING) AS ws,
               COUNT(*) AS n, CAST(MAX(q.start_time) AS STRING) AS last_active
        FROM system.query.history q
        WHERE q.start_time >= dateadd(DAY, -30, current_timestamp()){qsf}
        GROUP BY 1 ORDER BY n DESC LIMIT 10""", "system.query.history (top users)")]

    feat = _run(warehouse_id, f"""
        SELECT CAST(u.workspace_id AS STRING) AS ws, u.billing_origin_product AS product,
               ROUND(SUM(u.usage_quantity), 1) AS dbus
        FROM system.billing.usage u
        WHERE u.usage_date >= dateadd(DAY, -30, current_date()){wsf}
        GROUP BY 1, 2 HAVING SUM(u.usage_quantity) > 0
        ORDER BY 1, 3 DESC""", "system.billing.usage (feature adoption)")
    all_products = sorted({str(r.get("product")) for r in feat})
    by_ws: dict[str, list[dict[str, Any]]] = {}
    for r in feat:
        by_ws.setdefault(str(r.get("ws")), []).append(
            {"product": str(r.get("product")), "dbus": _f(r.get("dbus"))})
    feature_matrix = sorted(
        [{"workspace": ws, "products": ps, "breadth": len(ps)} for ws, ps in by_ws.items()],
        key=lambda x: -x["breadth"])
    avg_breadth = (sum(x["breadth"] for x in feature_matrix) / len(feature_matrix)) if feature_matrix else 0.0

    # Value map: reads per table over 30d (real lineage events) × freshness
    # (days since last_altered). Classification is transparent: gold = read in
    # the window and in the top quartile of reads; archive candidate = zero
    # reads and untouched for 30+ days; standard = everything else.
    value_map: list[dict[str, Any]] = []
    try:
        reads = _run(warehouse_id, """
            SELECT source_table_full_name AS fqn, COUNT(*) AS reads,
                   CAST(MAX(event_time) AS STRING) AS last_read
            FROM system.access.table_lineage
            WHERE event_time >= dateadd(DAY, -30, current_timestamp())
              AND source_table_full_name IS NOT NULL
              AND source_table_full_name NOT LIKE 'system.%'
              AND source_table_full_name NOT LIKE 'samples.%'
              AND source_table_full_name NOT LIKE '\\_\\_databricks\\_internal%'
            GROUP BY 1""", "system.access.table_lineage (value map)")
        reads_by_fqn = {str(r.get("fqn")): int(_f(r.get("reads"))) for r in reads}
        today = time.strftime("%Y-%m-%d", time.gmtime())
        nonzero = sorted(v for v in reads_by_fqn.values() if v > 0)
        p75 = nonzero[int(len(nonzero) * 0.75)] if nonzero else 0
        for t in _cached_payload("tables", warehouse_id):
            if t["table_type"] in ("HMS", "VIEW", "MATERIALIZED_VIEW", "METRIC_VIEW"):
                continue
            n_reads = reads_by_fqn.get(t["fqn"], 0)
            altered = t.get("last_altered") or t.get("created") or ""
            try:
                fresh_days = max(0, (time.mktime(time.strptime(today, "%Y-%m-%d"))
                                     - time.mktime(time.strptime(altered, "%Y-%m-%d"))) / 86400)
            except ValueError:
                continue
            cls = ("gold" if n_reads > 0 and n_reads >= p75
                   else "archive" if n_reads == 0 and fresh_days > 30
                   else "standard")
            value_map.append({"fqn": t["fqn"], "reads_30d": n_reads,
                              "days_since_update": int(fresh_days), "class": cls})
        value_map.sort(key=lambda x: -x["reads_30d"])
        value_map = value_map[:300]
    except LiveError:
        pass  # lineage not readable — the card explains instead of faking

    return {
        "mau": mau, "wau": wau, "queries_month": queries_month,
        "genie_adopters": genie_users, "ai_adopters": ai_users,
        "feature_breadth_avg": round(avg_breadth, 1),
        "num_products": len(all_products),
        "all_products": all_products,
        "feature_matrix": feature_matrix,
        "top_users": top_users,
        "value_map": value_map,
        "num_gold": sum(1 for v in value_map if v["class"] == "gold"),
        "num_archive": sum(1 for v in value_map if v["class"] == "archive"),
    }
