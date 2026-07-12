"""FastAPI entry point for the FinOps Command Center.

Serves the built React SPA from ``frontend/dist`` and the API under ``/api/*``.
Designed for deployment as a Databricks App (uvicorn on port 8000).

Every endpoint reads REAL data: the system tables (billing, query history,
information_schema, data-quality) via the configured SQL warehouse — see
``data/live.py``. All reads run on-behalf-of-user (the forwarded viewer
token), so data access follows each viewer's own permissions. There is no
demo/sample mode; a failed read surfaces as an honest 503 naming the object
to fix, never as substitute numbers.

The AUD FX rate is a deploy-time setting (customise.yaml ``fx_aud`` →
FINOPS_FX_AUD): to change it, edit the config and redeploy. The Configuration page
manages the workspace scope (stored in the app's own state store), lists the
cached data objects, and documents the access risk-flag rules read-only.
"""
from __future__ import annotations

import asyncio
import json
import os
import time
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel

from data import live
from data.config import get_features, get_settings

APP_ROOT = Path(__file__).parent
FRONTEND_DIST = APP_ROOT / "frontend" / "dist"

# Deploy-verification stamp: mtime of this file as shipped. /api/config carries
# it so "is the new build actually live?" is a one-request check.
_BUILD = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(Path(__file__).stat().st_mtime))

# Resolved deploy-time settings + feature flags. Env var > config.yaml >
# default — see data/config.py for the precedence contract.
_SETTINGS = get_settings()
_FEATURES = get_features()

WAREHOUSE_ID = str(_SETTINGS.get("warehouse_id") or "")
# Deploy-time FX: AUD = USD list price × this rate. Change customise.yaml /
# FINOPS_FX_AUD and redeploy — deliberately no runtime override.
FX_AUD = float(_SETTINGS["fx_rate"])

app = FastAPI(title="FinOps Command Center", version="2.0.0")


# Databricks Apps on-behalf-of-user: the Apps proxy forwards the signed-in
# viewer's token here. live.py runs EVERY estate read with it, and the
# viewer's identity keys the per-user cache rows.
@app.middleware("http")
async def _forward_user_token(request, call_next):  # type: ignore[no-untyped-def]
    ctx = live.USER_TOKEN.set(request.headers.get("x-forwarded-access-token", ""))
    uid = (request.headers.get("x-forwarded-email")
           or request.headers.get("x-forwarded-preferred-username")
           or request.headers.get("x-forwarded-user") or "")
    ctx_uid = live.USER_ID.set(uid)
    try:
        return await call_next(request)
    finally:
        live.USER_TOKEN.reset(ctx)
        live.USER_ID.reset(ctx_uid)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _wrap(payload: Any, cache: dict[str, Any] | None = None) -> dict[str, Any]:
    out = {"data": payload}
    if cache is not None:
        out["cache"] = cache
    return out


def _live_call(fn_name: str, *args: Any) -> Any:
    """Run a data.live function, mapping LiveError to the standard 503."""
    try:
        return getattr(live, fn_name)(*args)
    except live.LiveError as e:
        raise HTTPException(status_code=503, detail=f"live read failed — {e.source}: {e.detail}")


def _cached(object_id: str) -> tuple[Any, dict[str, Any]]:
    """Serve a registered cache object: (payload, cache-meta). Stale objects
    are served as-is while a background refresh runs."""
    try:
        return live.cached(object_id, WAREHOUSE_ID)
    except live.LiveError as e:
        raise HTTPException(status_code=503, detail=f"live read failed — {e.source}: {e.detail}")


def _platform_total() -> float:
    """Total platform spend this month, for the '% of total spend' context on
    the Genie/AI pages. Best-effort so it never breaks those responses."""
    try:
        return float(live.cached("platform_total", WAREHOUSE_ID)[0].get("usd") or 0.0)
    except Exception:
        return 0.0


# ---------------------------------------------------------------------------
# API — config + admin + health
# ---------------------------------------------------------------------------

@app.get("/api/config")
def get_config() -> dict[str, Any]:
    fx = FX_AUD
    return {
        "app_name": "FinOps Command Center",
        "app_short": "FinOps CC",
        "build": _BUILD,
        "customer": os.environ.get("FINOPS_CUSTOMER_NAME", "Energy for All"),
        # The signed-in viewer (X-Forwarded-Email) — shown on the nav bar; all
        # estate reads run with this identity.
        "viewer": live.USER_ID.get() or None,
        # Dual-currency toggle. USD is the source-of-truth list price; AUD is an
        # indicative conversion at the deploy-time FX rate.
        "currencies": [
            {"code": "USD", "symbol": "$", "rate": 1.0, "label": "USD (list price)"},
            {"code": "AUD", "symbol": "A$", "rate": fx, "label": f"AUD (× {fx} FX)"},
        ],
        "fx_aud": fx,
        "base_currency": "USD",
        # Feature flags: Ask Genie banner (genie), Data Quality tab (dqm), LLM
        # narration (ai_narration). Off ⇒ surface hidden AND endpoint inert.
        "features": {
            "genie": bool(_FEATURES["genie"]),
            "ai_narration": bool(_FEATURES["ai_narration"]),
            "dqm": bool(_FEATURES["dqm"]),
        },
        "genie_space_id": str(_SETTINGS["genie_space_id"]),
        # The Claude endpoint behind ai_query reviews (Query Advisor) and
        # narration — shown so the UI can attribute AI output to its model.
        "llm_endpoint": str(_SETTINGS["llm_endpoint"]),
    }


@app.get("/api/admin/config")
def get_admin_config() -> dict[str, Any]:
    """Read-only documentation payload for the Configuration page — sourced from the
    same constants the features are computed from."""
    return {"risk_definitions": live.RISK_DEFINITIONS}


@app.get("/api/admin/workspaces")
def get_admin_workspaces() -> dict[str, Any]:
    """The FULL workspace universe with per-workspace spend and the current
    included/excluded state, for the Admin scope picker. Served from the
    stored workspace_universe table (built once; Refresh rebuilds it)."""
    universe = _live_call("workspace_universe", WAREHOUSE_ID)
    try:
        scope = live.workspace_scope(WAREHOUSE_ID)
    except live.LiveError:
        scope = None
    rows = [{
        "workspace_id": w["workspace_id"],
        "spend_usd_month": w["spend_usd_month"],
        "dbus_month": w["dbus_month"],
        "included": scope is None or w["workspace_id"] in scope,
    } for w in universe["rows"]]
    return {"data": rows, "scope_active": scope is not None,
            "num_included": sum(1 for r in rows if r["included"]),
            "computed_at": universe["computed_at"] or None}


@app.post("/api/admin/workspaces/refresh")
def refresh_admin_workspaces() -> dict[str, Any]:
    """Rebuild the stored workspace list from a fresh billing scan."""
    _live_call("refresh_workspace_universe", WAREHOUSE_ID)
    return get_admin_workspaces()


class WorkspaceScopeUpdate(BaseModel):
    # Workspace IDs to INCLUDE. An empty list clears the filter (= all).
    included: list[str]


@app.post("/api/admin/workspaces")
def set_admin_workspaces(update: WorkspaceScopeUpdate) -> dict[str, Any]:
    """Persist the included-workspace set to the app's UC schema. Every
    workspace-scoped query (billing + query history) honours it; caches are
    invalidated on save."""
    ids = [str(i).strip() for i in update.included]
    if len(ids) > 5000:
        raise HTTPException(status_code=422, detail="too many workspace ids (max 5000)")
    if any(not i.isdigit() or len(i) > 20 for i in ids):
        raise HTTPException(status_code=422, detail="workspace ids must be numeric")
    _live_call("set_workspace_scope", WAREHOUSE_ID, ids)
    return get_admin_workspaces()


@app.get("/api/admin/cache")
def get_admin_cache() -> dict[str, Any]:
    """Every registered cache object (grouped by tab in the UI) with its
    freshness, refresh state and the queries a refresh recomputes."""
    return {"data": _live_call("cache_status", WAREHOUSE_ID), "ttl_seconds": live.CACHE_TTL_SECONDS}


@app.post("/api/admin/cache/{object_id}/refresh")
def post_admin_cache_refresh(object_id: str) -> dict[str, Any]:
    """Kick a background rebuild of one object (no-op when already
    refreshing) and return the fresh status list."""
    _live_call("refresh_object", object_id, WAREHOUSE_ID)
    return {"data": _live_call("cache_status", WAREHOUSE_ID), "ttl_seconds": live.CACHE_TTL_SECONDS}


@app.get("/api/health")
def get_health() -> dict[str, Any]:
    """Preflight: is the warehouse reachable + can the app read the required
    system tables? Structured report so misconfig surfaces on boot."""
    return live.preflight(WAREHOUSE_ID)


# ---------------------------------------------------------------------------
# API — overview + cost drivers
# ---------------------------------------------------------------------------

@app.get("/api/overview")
def get_overview() -> dict[str, Any]:
    payload, meta = _cached("overview")
    return _wrap(payload, cache=meta)


@app.get("/api/cost-drivers")
def get_cost_drivers(workspace: str = Query("all")) -> dict[str, Any]:
    """Cost by billing_origin_product + SKU breakdown + per-driver monthly
    trend + MoM, from system.billing.usage. Estate-level (``all``) serves the
    cache object; per-workspace drill-downs stay live (short in-process memo)."""
    if workspace in ("all", "", None):
        payload, meta = _cached("cost_drivers")
        return _wrap(payload, cache=meta)
    return _wrap(_live_call("cost_drivers_live", WAREHOUSE_ID, workspace))


# ---------------------------------------------------------------------------
# API — access
# ---------------------------------------------------------------------------

@app.get("/api/access/grants")
def get_grants() -> dict[str, Any]:
    """All DIRECT Unity Catalog grants with per-grant concern classification.
    The Access page aggregates these client-side (by object / by principal) —
    a few hundred rows, one endpoint, no server round-trips while exploring."""
    rows, meta = _cached("grants")
    return _wrap(rows, cache=meta)


# ---------------------------------------------------------------------------
# API — workspaces
# ---------------------------------------------------------------------------

@app.get("/api/workspaces")
def get_workspaces(
    complexity: str = Query("all"),
    health: str = Query("all"),
    search: str = Query(""),
) -> dict[str, Any]:
    rows, meta = _cached("workspaces")
    if complexity != "all":
        rows = [r for r in rows if r["complexity"] == complexity]
    if health != "all":
        rows = [r for r in rows if r["health"] == health]
    if search:
        s = search.lower()
        rows = [r for r in rows if s in r["workspace"].lower()]
    return _wrap(rows, cache=meta)


@app.get("/api/workspaces/{workspace_id}")
def get_workspace_detail(workspace_id: str) -> dict[str, Any]:
    detail = _live_call("workspace_detail_live", WAREHOUSE_ID, workspace_id)
    if detail is None:
        raise HTTPException(status_code=404, detail=f"Unknown workspace: {workspace_id}")
    return _wrap(detail)


# ---------------------------------------------------------------------------
# API — queries + recommendations
# ---------------------------------------------------------------------------

@app.get("/api/queries")
def get_queries(
    workspace: str = Query("all"),
    warehouse: str = Query("all"),
    time_range: str = Query("24h"),
    p95_threshold: float = Query(0.0),
    flag: str = Query("all"),
    insight_type: str = Query("all"),
    search: str = Query(""),
) -> dict[str, Any]:
    """Query Advisor rows — served from the cached advisor rollups; each
    statement classified from its own measured metrics."""
    _, meta = _cached("advisor")
    rows = _live_call("queries_live", WAREHOUSE_ID, time_range)
    if workspace != "all":
        rows = [r for r in rows if r["workspace"] == workspace]
    if warehouse != "all":
        rows = [r for r in rows if r["warehouse"] == warehouse]
    if p95_threshold:
        rows = [r for r in rows if r["p95_s"] >= p95_threshold]
    if flag != "all":
        rows = [r for r in rows if flag in r["flags"]]
    if insight_type != "all":
        rows = [r for r in rows if r["insight_type"] == insight_type]
    if search:
        s = search.lower()
        rows = [r for r in rows if s in (r["query_text"] or "").lower() or s in (r["user"] or "").lower() or s in (r["warehouse"] or "").lower()]
    return _wrap(rows, cache=meta)


@app.post("/api/queries/analyse")
def post_query_analyse(fingerprint: str = Query(...)) -> dict[str, Any]:
    """On-demand ai_query review of one statement fingerprint — the model
    call runs as the signed-in viewer; the stored advice is patched into the
    viewer's cached rollups so the page shows it immediately."""
    return _wrap(_live_call("analyse_now", WAREHOUSE_ID, fingerprint))


@app.get("/api/recommendations/hub")
def get_recommendations_hub(
    workspace: str = Query("all"),
    priority: str = Query("all"),   # all | P1 | P2 | P3
    category: str = Query("all"),
    scope: str = Query("all"),
) -> dict[str, Any]:
    """Prioritised hub: recommendations derived from real query metrics plus
    the tagging gap, with the cost-attribution rollup."""
    payload, meta = _cached("hub")
    recs = payload["recommendations"]
    if priority != "all":
        recs = [r for r in recs if r["priority"] == priority]
    if category != "all":
        recs = [r for r in recs if r["category"] == category]
    if workspace != "all":
        recs = [r for r in recs if r.get("workspace") == workspace]
    wrapped = _wrap(recs, cache=meta)
    wrapped["summary"] = payload["summary"]
    wrapped["attribution"] = payload["attribution"]
    return wrapped


# ---------------------------------------------------------------------------
# API — Genie $ + AI $  (always on — deterministic billing attribution)
# ---------------------------------------------------------------------------

@app.get("/api/genie-cost")
def get_genie_cost(workspace: str = Query("all")) -> dict[str, Any]:
    """Genie spend by surface × workspace × user from system.billing.usage.
    USD list price only. Estate view serves the cache object; per-workspace
    filters stay live."""
    if workspace in ("all", "", None):
        payload, meta = _cached("genie_cost")
        payload = dict(payload)
    else:
        payload, meta = _live_call("genie_cost_live", WAREHOUSE_ID, workspace), None
    payload["total_platform_spend_usd_month"] = _platform_total()
    return _wrap(payload, cache=meta)


@app.get("/api/apps-cost")
def get_apps_cost() -> dict[str, Any]:
    """Apps $: per-app compute cost + runtime, declared resource assets with
    attributable month-to-date cost, and best-practice flags."""
    payload, meta = _cached("apps_cost")
    return _wrap(payload, cache=meta)


@app.post("/api/apps/identity-label")
def post_app_identity_label(body: dict[str, Any]) -> dict[str, Any]:
    """Name a caller identity — OAuth app integration or service principal —
    for the caller-attribution card (used when the audit window can't name
    it). Empty name deletes the label. The UI refreshes the apps_cost object."""
    iid = body.get("integration_id")
    name = body.get("name", "")
    if not isinstance(iid, str) or not isinstance(name, str):
        raise HTTPException(status_code=422, detail='body must be {"integration_id": "...", "name": "..."}')
    return {"labels": _live_call("set_app_identity_label", WAREHOUSE_ID, iid, name)}


@app.get("/api/ai-cost")
def get_ai_cost(workspace: str = Query("all")) -> dict[str, Any]:
    """AI spend across the AI-family billing products, by product, endpoint,
    owner, workspace + a real 6-month trend. Estate view serves the cache
    object; per-workspace filters stay live."""
    if workspace in ("all", "", None):
        payload, meta = _cached("ai_cost")
        payload = dict(payload)
    else:
        payload, meta = _live_call("ai_cost_live", WAREHOUSE_ID, workspace), None
    payload["total_platform_spend_usd_month"] = _platform_total()
    return _wrap(payload, cache=meta)


# ---------------------------------------------------------------------------
# API — Ask Genie  (gated by features.genie — inert when off)
# ---------------------------------------------------------------------------

class GenieAskRequest(BaseModel):
    question: str


@app.post("/api/genie/ask")
async def genie_ask(req: GenieAskRequest) -> Any:
    """Stream the real Genie space's answer (SSE: meta → token* → done).
    When the space can't answer, the stream says so honestly."""
    if not _FEATURES["genie"]:
        return JSONResponse({"detail": "Genie feature disabled"}, status_code=404)

    from data import genie_client

    # The generator below streams AFTER this handler returns, when the
    # request contextvar may already be reset — capture the viewer token now.
    viewer_token = live.USER_TOKEN.get()

    async def stream() -> Any:
        live.USER_TOKEN.set(viewer_token)
        # Answers can take minutes (Genie generates SQL, runs an account-wide
        # billing scan, narrates). Emit SSE comment keepalives while waiting so
        # the Apps proxy never sees an idle connection.
        answer: str | None = None
        if genie_client.is_available():
            # to_thread (not run_in_executor): it copies the request context,
            # so the forwarded viewer token reaches the Genie client.
            task = asyncio.create_task(asyncio.to_thread(genie_client.ask, req.question))
            while True:
                done, _ = await asyncio.wait([task], timeout=5)
                if done:
                    break
                yield ": keepalive\n\n"
            try:
                answer = task.result()
            except Exception:  # noqa: BLE001
                answer = None
        source = "genie" if answer else "error"
        body = answer or (
            "Genie could not answer from the live space. Try rephrasing, or ask "
            "again in a moment — long account-wide scans can time out."
        )
        meta = {
            "asked_question": req.question,
            "source": source,
            "caveat": "Live Genie answer over system.billing / system.query tables — USD list price.",
        }
        yield f"data: {json.dumps({'type': 'meta', 'payload': meta})}\n\n"
        for word in body.split(" "):
            yield f"data: {json.dumps({'type': 'token', 'token': word + ' '})}\n\n"
            await asyncio.sleep(0.01)
        yield f"data: {json.dumps({'type': 'done'})}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")


# ---------------------------------------------------------------------------
# API — Data Quality Monitoring  (gated by features.dqm — 404 when off)
# ---------------------------------------------------------------------------

@app.get("/api/dqm")
def get_dqm(
    quality: str = Query("all"),
    freshness: str = Query("all"),
    search: str = Query(""),
) -> dict[str, Any]:
    """Monitors discovered from their Lakehouse-Monitoring output tables +
    DATA_QUALITY_MONITORING billing; quality statuses only when the viewer
    may read system.data_quality_monitoring.table_results. 404 when the
    feature flag is off."""
    if not _FEATURES["dqm"]:
        return JSONResponse({"detail": "Data Quality Monitoring feature disabled"}, status_code=404)

    payload, meta = _cached("dqm")
    rows = payload["monitors"]
    if quality != "all":
        rows = [r for r in rows if (r.get("quality_status") or "") == quality]
    if freshness != "all":
        rows = [r for r in rows if r.get("freshness") == freshness]
    if search:
        s = search.lower()
        rows = [r for r in rows if s in r["fqn"].lower() or s in (r.get("owner") or "").lower()]
    wrapped = _wrap(rows, cache=meta)
    wrapped["summary"] = payload["summary"]
    wrapped["by_workspace"] = payload["by_workspace"]
    wrapped["caveat"] = payload["caveat"]
    return wrapped


# ---------------------------------------------------------------------------
# API — tables
# ---------------------------------------------------------------------------

@app.get("/api/tables")
def get_tables(
    table_type: str = Query("all"),
    catalog: str = Query("all"),
    search: str = Query(""),
) -> dict[str, Any]:
    rows, meta = _cached("tables")
    if table_type != "all":
        rows = [r for r in rows if r["table_type"] == table_type]
    if catalog != "all":
        rows = [r for r in rows if r["catalog"] == catalog]
    if search:
        s = search.lower()
        rows = [r for r in rows if s in r["fqn"].lower() or s in (r.get("owner") or "").lower()]
    # KPI summary reflects the active filters so the numbers reconcile to the
    # visible rows. The frontend reads envelope.summary.
    payload = _wrap(rows, cache=meta)
    payload["summary"] = live.tables_summary(rows)
    return payload


@app.get("/api/tables/health")
def get_tables_health() -> dict[str, Any]:
    """Measured layout health of the most-read tables — DESCRIBE DETAIL
    probes + Predictive Optimization activity, cached like every page
    object."""
    payload, meta = _cached("table_health")
    return _wrap(payload, cache=meta)


@app.get("/api/tables/probe")
def get_table_probe(fqn: str = Query(...)) -> dict[str, Any]:
    """On-demand DESCRIBE DETAIL of ONE inventoried table, as the viewer
    (row expand on the Tables page)."""
    return _wrap(_live_call("table_probe_live", WAREHOUSE_ID, fqn))


# ---------------------------------------------------------------------------
# API — governance
# ---------------------------------------------------------------------------

@app.get("/api/adoption")
def get_adoption() -> dict[str, Any]:
    """Adoption & value: active identities, per-workspace product adoption,
    most-active users and the table value map — all measured, no estimates."""
    payload, meta = _cached("adoption")
    return _wrap(payload, cache=meta)


@app.get("/api/tags")
def get_tags() -> dict[str, Any]:
    """Tag coverage + key catalog (billing custom_tags + UC securable tags)
    — cached like every page object."""
    payload, meta = _cached("tags")
    return _wrap(payload, cache=meta)


@app.get("/api/tags/search")
def get_tag_search(key: str = Query(...), value: str = Query("")) -> dict[str, Any]:
    """Everything carrying one tag — billed resources with month-to-date cost
    plus Unity Catalog securables. Live per-key drill-down (short memo)."""
    return _wrap(_live_call("tag_search_live", WAREHOUSE_ID, key, value or None))


@app.get("/api/tags/exclusions")
def get_tag_exclusions() -> dict[str, Any]:
    """Operator-excluded blanket tag keys (don't count toward coverage)."""
    return {"keys": _live_call("tag_exclusions", WAREHOUSE_ID)}


@app.post("/api/tags/exclusions")
def post_tag_exclusions(body: dict[str, Any]) -> dict[str, Any]:
    """Overwrite the excluded-key set. Applies to every tagging metric
    (Tags, Governance, workspace checks, hub) for all viewers; caches clear
    so the numbers recompute consistently."""
    keys = body.get("keys")
    if not isinstance(keys, list) or not all(isinstance(k, str) for k in keys):
        raise HTTPException(status_code=422, detail="body must be {\"keys\": [\"tag_key\", …]}")
    return {"keys": _live_call("set_tag_exclusions", WAREHOUSE_ID, keys)}


@app.get("/api/governance")
def get_governance(status: str = Query("all")) -> dict[str, Any]:
    report, meta = _cached("governance")
    if status != "all":
        report = {**report, "tiles": [t for t in report["tiles"] if t["status"] == status]}
    return _wrap(report, cache=meta)


# ---------------------------------------------------------------------------
# Static frontend (must be registered AFTER the API routes)
# ---------------------------------------------------------------------------

_NO_CACHE_HEADERS = {
    "Cache-Control": "no-cache, no-store, must-revalidate",
    "Pragma": "no-cache",
    "Expires": "0",
}

# The dist check is per-request (a cheap stat), not import-time: start.sh may
# still be building the SPA on the app container when uvicorn binds the port,
# and the frontend must start serving the moment frontend/dist lands — without
# a process restart. /assets/* is covered by the catch-all (target.is_file()).

_PLACEHOLDER = {
    "status": "frontend build not found",
    "hint": "The SPA is building on the app container (see the app logs). /api/* is fully served meanwhile.",
}


@app.get("/")
def index() -> Any:
    if (FRONTEND_DIST / "index.html").is_file():
        return FileResponse(str(FRONTEND_DIST / "index.html"), headers=_NO_CACHE_HEADERS)
    return JSONResponse(_PLACEHOLDER)


@app.get("/{full_path:path}")
def spa_fallback(full_path: str) -> Any:
    if full_path.startswith("api/"):
        return JSONResponse({"detail": "Not Found"}, status_code=404)
    target = FRONTEND_DIST / full_path
    if ".." not in full_path and target.is_file():
        return FileResponse(str(target), headers=_NO_CACHE_HEADERS)
    if (FRONTEND_DIST / "index.html").is_file():
        return FileResponse(str(FRONTEND_DIST / "index.html"), headers=_NO_CACHE_HEADERS)
    return JSONResponse(_PLACEHOLDER)
