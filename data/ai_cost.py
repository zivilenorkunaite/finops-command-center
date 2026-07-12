"""AI spend attribution — all the AI/GenAI billing products a team investigates.

Shapes the AI-family ``billing_origin_product`` rows fetched by ``data/live.py``
into the AI $ page payload: spend by product, by serving endpoint / model, by
owner, by workspace, and the real 6-month trend. Genie is tracked on its own
[Genie $] page; this covers the rest. Everything is USD list price straight
from billing.
"""
from __future__ import annotations

import time
from typing import Any

# The AI-family billing_origin_product values (verified present in real
# system.billing.usage) and their friendly labels. Genie is deliberately NOT
# here — it has its own page.
AI_PRODUCTS: list[tuple[str, str]] = [
    ("MODEL_SERVING", "Model Serving"),
    ("AI_GATEWAY", "AI Gateway"),
    ("VECTOR_SEARCH", "Vector Search"),
    ("AGENT_BRICKS", "Agent Bricks"),
    ("AI_FUNCTIONS", "AI Functions"),
    ("FOUNDATION_MODEL_TRAINING", "Fine-tuning / training"),
]
PRODUCT_LABEL = {c: l for c, l in AI_PRODUCTS}

CAVEATS = [
    "Covers the AI-family billing_origin_product lines (Model Serving, Foundation Model API, Vector Search, Agent Bricks, AI Functions, fine-tuning). Genie is tracked separately on the Genie $ page.",
    "Endpoint + owner come from usage_metadata.endpoint_name and identity_metadata; where an endpoint is shared the owner is the creator, not every caller.",
    "The Databricks Assistant is not metered and does not appear here.",
    "$ is list-price reference (usage_quantity x pricing.effective_list.default); the Account Console is the source of truth. Provisioned-throughput endpoints bill whether or not they serve traffic.",
]


def assemble(rows_all: list[dict[str, Any]], workspace: str | None,
             trend: dict[str, Any]) -> dict[str, Any]:
    """Build the AI-spend payload from billing endpoint rows + the real
    6-month trend (both queried by live.ai_cost_live).

    Each row: {name, product, product_label, workspace, owner, dbus_month,
    list_usd_month, mode, gpu}."""
    scoped = None if not workspace or workspace in ("all", "") else workspace
    rows = [r for r in rows_all if not scoped or r["workspace"] == scoped]

    total_usd = round(sum(r["list_usd_month"] for r in rows), 2)
    total_dbus = round(sum(r["dbus_month"] for r in rows), 1)

    # by product
    prod: dict[str, dict[str, Any]] = {}
    for r in rows:
        p = prod.setdefault(r["product"], {"code": r["product"], "label": r["product_label"], "list_usd": 0.0, "dbus": 0.0, "endpoints": 0})
        p["list_usd"] += r["list_usd_month"]
        p["dbus"] += r["dbus_month"]
        p["endpoints"] += 1
    by_product = sorted(
        [{"code": p["code"], "label": p["label"], "list_usd": round(p["list_usd"], 2),
          "dbus": round(p["dbus"], 1), "endpoints": p["endpoints"],
          "pct": round(p["list_usd"] / total_usd, 4) if total_usd else 0.0} for p in prod.values()],
        key=lambda x: -x["list_usd"],
    )

    # by workspace
    ws: dict[str, dict[str, Any]] = {}
    for r in rows:
        w = ws.setdefault(r["workspace"], {"workspace": r["workspace"], "list_usd": 0.0, "endpoints": 0})
        w["list_usd"] += r["list_usd_month"]
        w["endpoints"] += 1
    by_workspace = sorted(
        [{"workspace": w["workspace"], "list_usd": round(w["list_usd"], 2), "endpoints": w["endpoints"]} for w in ws.values()],
        key=lambda x: -x["list_usd"],
    )

    # by user (owner)
    usr: dict[str, dict[str, Any]] = {}
    for r in rows:
        u = usr.setdefault(r["owner"], {"user": r["owner"], "list_usd": 0.0, "endpoints": 0, "prod": {}})
        u["list_usd"] += r["list_usd_month"]
        u["endpoints"] += 1
        u["prod"][r["product_label"]] = u["prod"].get(r["product_label"], 0.0) + r["list_usd_month"]
    by_user = sorted(
        [{"user": u["user"], "list_usd": round(u["list_usd"], 2), "endpoints": u["endpoints"],
          "top_product": max(u["prod"], key=u["prod"].get) if u["prod"] else None} for u in usr.values()],
        key=lambda x: -x["list_usd"],
    )

    endpoints = [{
        "name": r["name"], "product": r["product"], "product_label": r["product_label"],
        "workspace": r["workspace"], "owner": r["owner"], "list_usd_month": r["list_usd_month"],
        "dbus_month": r["dbus_month"], "mode": r["mode"], "gpu": r["gpu"],
    } for r in rows]

    gpu_usd = round(sum(r["list_usd_month"] for r in rows if r["gpu"]), 2)

    return {
        "month": time.strftime("%Y-%m"),
        "workspace": scoped or "all",
        "by_product": by_product,
        "by_workspace": by_workspace,
        "by_user": by_user,
        "endpoints": endpoints,
        "trend": trend,
        "summary": {
            "total_list_usd_month": total_usd,
            "total_dbus_month": total_dbus,
            "num_endpoints": len(rows),
            "num_products": len(by_product),
            "distinct_users": len({r["owner"] for r in rows}),
            "num_workspaces": len({r["workspace"] for r in rows}),
            "top_product": by_product[0]["label"] if by_product else None,
            "gpu_usd_month": gpu_usd,
        },
        "caveats": CAVEATS,
    }
