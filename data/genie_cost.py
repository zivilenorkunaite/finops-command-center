"""Genie cost attribution — by surface, workspace and user. Always on.

Shapes the ``system.billing.usage`` rows fetched by ``data/live.py`` into the
Genie $ page payload. Facts verified against real billing data (2026):

  * Genie is billed under ``billing_origin_product = 'GENIE'`` (never filter by
    SKU — Genie shares the region-suffixed real-time-inference SKU).
  * ``usage_metadata.genie.surface`` carries the surface. The values are shown
    AS BILLED, case-fixed only (GENIE_CODE → "Genie Code", GENIE_ONE →
    "Genie One", GENIE_AGENTS → "Genie Agents"; NULL → "Unknown"). The enum is
    open — label whatever appears rather than assuming a fixed set.
  * ``identity_metadata.run_as`` = user; ``workspace_id`` = origin workspace.
  * $ = usage_quantity × pricing.effective_list.default (USD list price).
    Billing carries no discount/commitment information — the Account Console
    invoice is authoritative.
"""
from __future__ import annotations

from typing import Any

CAVEATS = [
    "Surface comes straight from usage_metadata.genie.surface, case-fixed only (e.g. GENIE_ONE → Genie One). The enum is open — new values are shown as billed, never dropped.",
    "Dollar figures are USD list price (usage_quantity × effective list rate). Billing carries no discount or commitment information — the Account Console invoice is authoritative.",
    "Rows are filtered on billing_origin_product = 'GENIE' (never by SKU name).",
    "Cost by Genie space: Genie DBUs cannot be split by space — billing carries no space id (only surface / channel / agent_id). The per-space card instead attributes the SQL-warehouse compute of each space's generated queries (query_source.genie_space_id in system.query.history), allocated HOUR-MATCHED: each billed warehouse-hour is split by that hour's task-time shares (denominator floored at one compute-hour), so hours where the space ran nothing cost it nothing and idle burn stays unattributed.",
]


def surface_label(surface: str) -> str:
    """The billed surface value, case-fixed only (GENIE_ONE → 'Genie One').
    The enum is open, so prettify unknowns rather than dropping them."""
    if not surface or surface.upper() == "UNKNOWN":
        return "Unknown"
    return surface.replace("_", " ").title().strip()


def assemble(gt_rows: list[dict[str, Any]], workspace: str | None = None) -> dict[str, Any]:
    """Build the Genie-cost payload from billing rows.

    Each row: {usage_month, workspace, user_identity, surface, label,
    total_dbus, total_list_cost_usd}.
    """
    scoped = None if not workspace or workspace in ("all", "") else workspace
    breakdown = sorted(
        [r for r in gt_rows if not scoped or r["workspace"] == scoped],
        key=lambda r: -r["total_list_cost_usd"],
    )
    by_ws = _workspace_totals_from(gt_rows)
    if scoped:
        by_ws = [w for w in by_ws if w["workspace"] == scoped]

    total_dbus = round(sum(r["total_dbus"] for r in breakdown), 1)
    total_list = round(sum(r["total_list_cost_usd"] for r in breakdown), 2)
    users = {r["user_identity"] for r in breakdown}
    surface_totals = _surface_totals(breakdown)
    month = next((r["usage_month"] for r in gt_rows if r.get("usage_month")), "")

    return {
        "month": month,
        "workspace": scoped or "all",
        "breakdown": breakdown,
        "surface_totals": surface_totals,
        "by_workspace": by_ws,
        "by_user": _user_totals(breakdown),
        "summary": {
            "total_dbus": total_dbus,
            "total_list_cost_usd": total_list,
            "distinct_users": len(users),
            "num_workspaces": len({r["workspace"] for r in breakdown}),
            "num_surfaces": len(surface_totals),
        },
        "caveats": CAVEATS,
    }


def _workspace_totals_from(full_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Per-workspace totals (distinct users, DBUs, $, per-surface DBUs)."""
    by_ws: dict[str, dict[str, Any]] = {}
    for r in full_rows:
        ws = by_ws.setdefault(r["workspace"], {
            "workspace": r["workspace"], "users": set(),
            "total_dbus": 0.0, "list_usd": 0.0, "surface_dbus": {},
        })
        ws["users"].add(r["user_identity"])
        ws["total_dbus"] += r["total_dbus"]
        ws["list_usd"] += r["total_list_cost_usd"]
        ws["surface_dbus"][r["label"]] = ws["surface_dbus"].get(r["label"], 0.0) + r["total_dbus"]
    out: list[dict[str, Any]] = []
    for ws in by_ws.values():
        out.append({
            "workspace": ws["workspace"],
            "distinct_users": len(ws["users"]),
            "total_dbus": round(ws["total_dbus"], 1),
            "surface_dbus": {k: round(v, 1) for k, v in ws["surface_dbus"].items()},
            "total_list_cost_usd": round(ws["list_usd"], 2),
        })
    out.sort(key=lambda r: -r["total_list_cost_usd"])
    return out


def _surface_totals(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Roll a breakdown row set up to per-surface totals, spend desc."""
    agg: dict[str, dict[str, Any]] = {}
    for r in rows:
        a = agg.setdefault(r["surface"], {
            "surface": r["surface"], "label": r["label"],
            "dbus": 0.0, "list_usd": 0.0,
        })
        a["dbus"] += r["total_dbus"]
        a["list_usd"] += r["total_list_cost_usd"]
    total_list = sum(a["list_usd"] for a in agg.values()) or 1.0
    ranked = sorted(agg.values(), key=lambda a: -a["list_usd"])
    return [
        {
            "surface": a["surface"], "label": a["label"],
            "dbus": round(a["dbus"], 1),
            "list_usd": round(a["list_usd"], 2),
            "pct": round(a["list_usd"] / total_list, 4),
        }
        for a in ranked
    ]


def _user_totals(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Per-user rollup for the Genie page leaderboard (across workspaces)."""
    agg: dict[str, dict[str, Any]] = {}
    for r in rows:
        u = agg.setdefault(r["user_identity"], {
            "user_identity": r["user_identity"],
            "total_dbus": 0.0, "list_usd": 0.0,
            "workspaces": set(), "surface_dbus": {},
        })
        u["total_dbus"] += r["total_dbus"]
        u["list_usd"] += r["total_list_cost_usd"]
        u["workspaces"].add(r["workspace"])
        u["surface_dbus"][r["label"]] = u["surface_dbus"].get(r["label"], 0.0) + r["total_dbus"]
    out = []
    for u in agg.values():
        top_surface = max(u["surface_dbus"], key=u["surface_dbus"].get) if u["surface_dbus"] else None
        out.append({
            "user_identity": u["user_identity"],
            "total_dbus": round(u["total_dbus"], 1),
            "total_list_cost_usd": round(u["list_usd"], 2),
            "num_workspaces": len(u["workspaces"]),
            "top_surface": top_surface,
        })
    out.sort(key=lambda r: -r["total_list_cost_usd"])
    return out
