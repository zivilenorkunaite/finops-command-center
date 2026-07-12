"""Estate cost drivers: spend by billing_origin_product and SKU, 6-month
trend and month-over-month change (current month projected to run-rate so a
partial month never reads as a drop).
"""
from __future__ import annotations

import re
import time
from typing import Any
from data.runtime import LiveError, _f, _run, _ttl_cache
from data.store import _ws_scope_sql


# ---------------------------------------------------------------------------
# Cost drivers — spend by billing_origin_product + SKU + 6-month trend.
# Powers the cost-by-driver / trend / spike charts on Overview + Workspaces.
# ---------------------------------------------------------------------------
_PRODUCT_LABEL = {
    "SQL": "SQL", "JOBS": "Jobs", "INTERACTIVE": "Interactive", "DLT": "DLT / Lakeflow",
    "ALL_PURPOSE": "All-Purpose", "MODEL_SERVING": "Model Serving", "AI_GATEWAY": "AI Gateway",
    "VECTOR_SEARCH": "Vector Search", "PREDICTIVE_OPTIMIZATION": "Predictive Optimization",
    "LAKEBASE": "Lakebase", "APPS": "Apps", "DATA_QUALITY_MONITORING": "Data Quality Monitoring",
    "GENIE": "Genie", "DATABASE": "Database", "AI_FUNCTIONS": "AI Functions",
    "AGENT_BRICKS": "Agent Bricks", "NETWORKING": "Networking",
}


def _plabel(code: str) -> str:
    return _PRODUCT_LABEL.get(code, code.title().replace("_", " "))


@_ttl_cache(600)
def cost_drivers_live(warehouse_id: str, workspace: str | None = None) -> dict[str, Any]:
    """Real cost-by-driver (billing_origin_product) + SKU breakdown + 6-month
    trend + MoM, from system.billing.usage. Estate-wide by default; scoped when
    a workspace_id is passed."""
    scoped = None if not workspace or workspace in ("all", "") else str(workspace)
    # The only user-influenced value inlined into SQL on this path — workspace
    # ids are numeric, so validate hard instead of escaping.
    if scoped and not re.fullmatch(r"[0-9]{1,20}", scoped):
        raise LiveError("cost drivers", f"invalid workspace id: {scoped!r}")
    wsf = (f" AND u.workspace_id = '{scoped}'" if scoped else "") + _ws_scope_sql(warehouse_id)
    price = ("LEFT JOIN system.billing.list_prices lp ON u.cloud=lp.cloud AND u.sku_name=lp.sku_name "
             "AND u.usage_start_time>=lp.price_start_time AND (lp.price_end_time IS NULL OR u.usage_start_time<lp.price_end_time)")

    # Current-month drivers
    drv = _run(warehouse_id,
               f"SELECT u.billing_origin_product AS product, SUM(u.usage_quantity) dbus, "
               f"SUM(u.usage_quantity*lp.pricing.effective_list.default) usd FROM system.billing.usage u {price} "
               f"WHERE u.usage_date>=date_trunc('MONTH',current_date()){wsf} GROUP BY 1", "cost-drivers (product)")
    total = sum(_f(r.get("usd")) for r in drv) or 1.0
    drivers = sorted(
        [{"driver": str(r["product"]), "label": _plabel(str(r["product"])),
          "spend_usd_month": round(_f(r.get("usd"))), "pct_of_total": round(_f(r.get("usd")) / total, 4)} for r in drv],
        key=lambda d: -d["spend_usd_month"])

    # Current-month SKU breakdown (cap to keep payload sane)
    sku = _run(warehouse_id,
               f"SELECT u.sku_name AS sku, u.billing_origin_product AS product, "
               f"SUM(u.usage_quantity*lp.pricing.effective_list.default) usd, SUM(u.usage_quantity) dbus "
               f"FROM system.billing.usage u {price} WHERE u.usage_date>=date_trunc('MONTH',current_date()){wsf} "
               f"GROUP BY 1,2 ORDER BY usd DESC LIMIT 40", "cost-drivers (sku)")
    # Shares divide by the TRUE month total (same window/join as the drivers)
    # — dividing by the top-40 subtotal would inflate every SKU's share.
    sku_breakdown = [{"sku": str(r["sku"]), "driver": str(r["product"]), "driver_label": _plabel(str(r["product"])),
                      "total_cost": round(_f(r.get("usd"))), "dbus_month": round(_f(r.get("dbus"))),
                      "pct_of_total": round(_f(r.get("usd")) / total, 4)} for r in sku]
    dbu_by_sku = [{"sku": s["sku"], "driver": s["driver"], "driver_label": s["driver_label"], "dbus_month": s["dbus_month"]}
                  for s in sku_breakdown if s["dbus_month"] > 0]

    # 6-month trend by product
    tr = _run(warehouse_id,
              f"SELECT date_format(date_trunc('MONTH',u.usage_date),'yyyy-MM') m, u.billing_origin_product product, "
              f"SUM(u.usage_quantity*lp.pricing.effective_list.default) usd FROM system.billing.usage u {price} "
              f"WHERE u.usage_date>=add_months(date_trunc('MONTH',current_date()),-5){wsf} GROUP BY 1,2", "cost-drivers (trend)")
    months = sorted({str(r["m"]) for r in tr})
    by_prod: dict[str, dict[str, float]] = {}
    for r in tr:
        by_prod.setdefault(str(r["product"]), {})[str(r["m"])] = _f(r.get("usd"))
    # MoM compares LIKE FOR LIKE: the current partial month is projected to a
    # 30.4-day run-rate before comparing to the full previous month —
    # otherwise every driver reads as a drop until month-end (same projection
    # as the workspace spend-trajectory check).
    day_of_month = max(1, int(time.strftime("%d")))
    proj = 30.4 / day_of_month
    series, mom = [], []
    for code, mm in by_prod.items():
        pts = [{"month": m, "spend_usd": round(mm.get(m, 0.0))} for m in months]
        last = pts[-1]["spend_usd"] if pts else 0
        prev = pts[-2]["spend_usd"] if len(pts) >= 2 else 0
        last_rr = last * proj
        series.append({"driver": code, "label": _plabel(code), "points": pts, "spend_usd_month": last})
        mom.append({"driver": code, "label": _plabel(code), "prev_usd_month": prev, "spend_usd_month": last,
                    "mom_pct": round(((last_rr - prev) / prev) if prev else 0.0, 4),
                    "delta_usd": round(last_rr - prev),
                    "basis": "current month projected to run-rate vs full previous month"})
    series.sort(key=lambda s: -s["spend_usd_month"])
    mom.sort(key=lambda m: -m["mom_pct"])

    return {
        "workspace": scoped or "all",
        "total_spend_usd_month": round(sum(d["spend_usd_month"] for d in drivers)),
        "drivers": drivers,
        "sku_breakdown": sku_breakdown,
        "dbu_by_sku": dbu_by_sku,
        "trend": {"months": months, "series": series, "mom": mom},
        "mom": mom,
    }
