"""Facade for the data layer — the single import surface (`from data import live`).

The implementation lives in focused modules; this file re-exports the public
API and OWNS the cache-object registry, wiring page loaders into the cache
machinery at import time. Layering (imports only point left):

    runtime → store → cache → feature modules → live (this facade)

    runtime        viewer-identity contextvars, SQL clients, _run, memo, escaping
    store          app-state store (Lakebase/UC) + workspace scope + tag exclusions
    cache          the 24h per-viewer object cache (stamped by package content)
    workspaces     facts, best-practice checks, overview, universe, detail
    drivers        cost drivers by product/SKU with run-rate MoM
    advisor        query mirror, rollups, ai_query reviews
    tables         inventory + DESCRIBE DETAIL layout health
    tags           coverage, key catalog, per-tag search
    access         direct grants + deterministic risk rules
    governance     scorecard + compute hygiene
    adoption       active identities, product breadth, value map
    product_costs  Genie $ / AI $ / Apps $
    dqm            data-quality monitors (three honest layers)
    hub            recommendations composed from the cached objects
    health         viewer preflight over the grant-requiring tables
"""
from __future__ import annotations

from typing import Any

# --- public API re-exports (app.py, data.genie_client) ----------------------
from data.runtime import (LiveError, USER_ID, USER_TOKEN, _f,  # noqa: F401
                          _viewer_principal)
from data.store import (app_identity_labels, set_app_identity_label,  # noqa: F401
                        set_tag_exclusions, set_workspace_scope,
                        tag_exclusions, workspace_scope)
from data.cache import (CACHE_TTL_SECONDS, _CACHE_REGISTRY,  # noqa: F401
                        _cached_payload, _purge_memo, cache_clear_all,
                        cache_status, cached, refresh_object)
from data.workspaces import (overview_live, platform_spend_total,  # noqa: F401
                             refresh_workspace_universe, workspace_detail_live,
                             workspace_universe, workspaces_live)
from data.drivers import cost_drivers_live  # noqa: F401
from data.advisor import advisor_payload, analyse_now, queries_live  # noqa: F401
from data.tables import (table_health_live, table_probe_live,  # noqa: F401
                         tables_live, tables_summary)
from data.tags import tag_search_live, tags_live  # noqa: F401
from data.access import RISK_DEFINITIONS, grants_live, risks_from  # noqa: F401
from data.governance import governance_live  # noqa: F401
from data.adoption import adoption_live  # noqa: F401
from data.product_costs import (ai_cost_live, apps_cost_live,  # noqa: F401
                                genie_cost_live)
from data.dqm import dqm_live  # noqa: F401
from data.hub import hub_live  # noqa: F401
from data.health import preflight  # noqa: F401



# The cache registry — one entry per expensive page payload. `queries`
# documents exactly what a refresh recomputes (shown on the Configuration page).
# `scope`: "user" = the loader reads estate data on-behalf-of-user, so each
# viewer gets their own row (permissions preserved); "shared" = the loader
# runs with the app's own credentials, one row for everyone. Every current
# loader reads as the viewer, so everything is "user" today.
# Loaders late-bind to the feature-module functions imported above.
_CACHE_REGISTRY.update({
    "overview": {
        "label": "Estate overview", "tab": "Overview", "scope": "user",
        "queries": "billing usage × list prices: month-to-date per-workspace facts; 12-week weekly spend trend; cost drivers by product with 6-month trend and month-over-month change",
        "loader": lambda wid: (_purge_memo("_workspace_facts"), overview_live(wid))[1],
    },
    "workspaces": {
        "label": "Workspace facts & ratings", "tab": "Workspaces", "scope": "user",
        "queries": "billing usage × list prices month-to-date, grouped per workspace: spend, DBUs, serverless / automation shares → health + optimisation-complexity ratings",
        "loader": lambda wid: (_purge_memo("_workspace_facts"), workspaces_live(wid))[1],
    },
    "cost_drivers": {
        "label": "Cost drivers (estate)", "tab": "Workspaces", "scope": "user",
        "queries": "billing usage × list prices by billing_origin_product and SKU: month-to-date breakdown, 6-month trend, month-over-month change",
        "loader": lambda wid: (_purge_memo("cost_drivers_live"), cost_drivers_live(wid, None))[1],
    },
    "grants": {
        "label": "Access grants & risk flags", "tab": "Access", "scope": "user",
        "queries": "information_schema catalog/schema/table privileges — DIRECT grants only, each classified against the risk rules; the Access page aggregates by object and by principal from this one list",
        "loader": lambda wid: grants_live(wid),
    },
    "advisor": {
        "label": "Query Advisor store & rollups", "tab": "Query Advisor", "scope": "user",
        "queries": "incremental system.query.history ingest into the app store (incl. wall-time phase breakdown, rows, result-cache hits, issuing source), fingerprint rollups for the 24h and 7d windows + billed warehouse cost by task-time share; AI reviews via SQL ai_query on the configured Claude endpoint (one per fingerprint, on demand or background batch, run as you)",
        "loader": lambda wid: advisor_payload(wid),
    },
    "tables": {
        "label": "Table inventory", "tab": "Tables", "scope": "user",
        "queries": "information_schema.tables (type, format, owner, created, last altered) + legacy hive_metastore SHOW SCHEMAS/TABLES listing",
        "loader": lambda wid: tables_live(wid),
    },
    "table_health": {
        "label": "Table health probes", "tab": "Tables", "scope": "user",
        "queries": "top-read tables from system.access.table_lineage (30d), each probed with DESCRIBE DETAIL (size, file counts, partition / liquid-clustering layout) + Predictive Optimization ops history — flags small files, Hive-style partitions, missing clustering and external tables",
        "loader": lambda wid: table_health_live(wid),
    },
    "tags": {
        "label": "Tag coverage & catalog", "tab": "Tags", "scope": "user",
        "queries": "billing usage custom_tags month-to-date: tagged vs untagged spend by product (operator-excluded blanket keys don't count) + per-key spend, coverage share and approximate value counts; Unity Catalog securable tags from the five information_schema *_tags views (catalog/schema/table/column/volume)",
        "loader": lambda wid: tags_live(wid),
    },
    "governance": {
        "label": "Governance scorecard", "tab": "Governance", "scope": "user",
        "queries": "billing custom_tags month-to-date tagging scan per workspace; compute-hygiene checks from system.compute.warehouses/clusters; tiles reuse the cached workspace facts, table inventory and access grants",
        "loader": lambda wid: governance_live(wid),
    },
    "adoption": {
        "label": "Adoption & value", "tab": "Adoption & Value", "scope": "user",
        "queries": "billing identities + products (30d), query.history active users / query counts / top users, and the value map from system.access.table_lineage reads × table freshness",
        "loader": lambda wid: adoption_live(wid),
    },
    "genie_cost": {
        "label": "Genie spend (estate)", "tab": "Genie $", "scope": "user",
        "queries": "billing usage where billing_origin_product = GENIE, month-to-date, by surface × user × workspace at list price",
        "loader": lambda wid: (_purge_memo("genie_cost_live"), genie_cost_live(wid, None))[1],
    },
    "apps_cost": {
        "label": "Apps spend & best practices", "tab": "Apps $", "scope": "user",
        "queries": "billing usage where billing_origin_product = APPS (per-app cost + runtime, month-to-date) + system.access.audit apps events (creator, deploys, lifecycle, declared resources) + caller attribution of warehouse compute — on-behalf-of via verbose-audit commandSubmit events and service-principal via query.history, allocated per warehouse-hour by task-time share with a one-compute-hour floor + full-cost assets (Lakebase instances, declared jobs, dedicated serving / vector-search endpoints) when declared by exactly one app",
        "loader": lambda wid: apps_cost_live(wid),
    },
    "ai_cost": {
        "label": "AI spend (estate)", "tab": "AI $", "scope": "user",
        "queries": "billing usage for the AI product family (serving, AI functions, vector search, agents…): by product, endpoint, owner, workspace + 6-month trend",
        "loader": lambda wid: (_purge_memo("ai_cost_live"), ai_cost_live(wid, None))[1],
    },
    "platform_total": {
        "label": "Platform spend total (month)", "tab": "Genie $ / AI $", "scope": "user",
        "queries": "sum of the cached per-workspace facts (same source as the Overview total) — the '% of total spend' context figure",
        "loader": lambda wid: {"usd": platform_spend_total(wid)},
    },
    "dqm": {
        "label": "Data quality monitors", "tab": "Data Quality", "scope": "user",
        "queries": "monitor discovery from *_profile_metrics / *_drift_metrics output tables in information_schema (freshness = output last_altered), DATA_QUALITY_MONITORING billing by workspace, and quality statuses from the optional system.data_quality_monitoring.table_results when the viewer holds that grant",
        "loader": lambda wid: dqm_live(wid),
    },
    "hub": {
        "label": "Recommendations hub", "tab": "Recommendations", "scope": "user",
        "queries": "composed from the cached advisor rollups, governance scorecard, workspace facts and table inventory — flagged statements, HMS migration, estate findings, cost attribution",
        "loader": lambda wid: hub_live(wid),
    },
})
