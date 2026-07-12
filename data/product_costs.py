"""Product cost tabs: Genie $, AI $ and Apps $ — straight from billing at
list price, with attribution only where it is REAL:
  * genie-space and app-caller warehouse compute, hour-matched from query
    history (plus the audit identity chain for on-behalf-of callers);
  * full-cost assets (Lakebase instances, declared jobs, dedicated serving /
    vector-search endpoints) only when declared by exactly one app.
Anything not attributable (app visitors, on-behalf-of serving calls) is
stated as such, never estimated.
"""
from __future__ import annotations

import json
import time
from data import ai_cost
from data import genie_cost
from typing import Any
from data.runtime import LiveError, _client, _f, _run, _ttl_cache
from data.store import _ws_scope_sql, app_identity_labels


# ---------------------------------------------------------------------------
# Genie $ — the first fully-wired live endpoint (queries.sql Q1-Q3).
# ---------------------------------------------------------------------------
_GENIE_GROUND_TRUTH_SQL = """
SELECT
  date_format(date_trunc('MONTH', u.usage_date), 'yyyy-MM')   AS usage_month,
  CAST(u.workspace_id AS STRING)                              AS workspace,
  u.identity_metadata.run_as                                  AS user_identity,
  COALESCE(u.usage_metadata.genie.surface, 'UNKNOWN')         AS surface,
  SUM(u.usage_quantity)                                       AS total_dbus,
  SUM(u.usage_quantity * lp.pricing.effective_list.default)   AS total_list_cost
FROM system.billing.usage u
LEFT JOIN system.billing.list_prices lp
  ON u.cloud = lp.cloud
 AND u.sku_name = lp.sku_name
 AND u.usage_start_time >= lp.price_start_time
 AND (lp.price_end_time IS NULL OR u.usage_start_time < lp.price_end_time)
WHERE u.billing_origin_product = 'GENIE'
  AND u.usage_date >= date_trunc('MONTH', current_date())
  AND u.identity_metadata.run_as IS NOT NULL{ws_scope}
GROUP BY 1, 2, 3, 4
"""


_GENIE_TITLE_CACHE: dict[str, str | None] = {}


def _genie_space_title(space_id: str) -> str | None:
    """Best-effort title lookup for a Genie space (viewer token; a space the
    viewer cannot see just shows its id). Titles are stable — memoized."""
    if space_id in _GENIE_TITLE_CACHE:
        return _GENIE_TITLE_CACHE[space_id]
    title: str | None = None
    try:
        title = str(getattr(_client().genie.get_space(space_id), "title", "") or "") or None
    except Exception:  # noqa: BLE001 — 403/404 → id shown instead
        title = None
    _GENIE_TITLE_CACHE[space_id] = title
    return title


def _genie_space_costs(warehouse_id: str) -> list[dict[str, Any]]:
    """Estimated SQL-warehouse compute per Genie space, month-to-date.

    Genie DBUs can NOT be split by space (billing carries no space id — only
    surface/channel/agent_id). What CAN be measured: every warehouse statement
    a space generated carries query_source.genie_space_id in
    system.query.history, so each space is charged its task-time share of the
    warehouse's billed cost, HOUR-MATCHED: only hours where the space
    actually ran queries are allocated; idle hours stay unattributed."""
    qsf = _ws_scope_sql(warehouse_id, "q.workspace_id")
    wsf = _ws_scope_sql(warehouse_id)
    rows = _run(warehouse_id, f"""
        WITH g AS (
            SELECT q.query_source.genie_space_id AS space_id,
                   q.compute.warehouse_id        AS wh,
                   date_trunc('HOUR', q.start_time) AS hr,
                   COUNT(*)                      AS queries,
                   SUM(q.total_task_duration_ms) AS task_ms
            FROM system.query.history q
            WHERE q.start_time >= date_trunc('MONTH', current_timestamp())
              AND q.query_source.genie_space_id IS NOT NULL{qsf}
            GROUP BY 1, 2, 3),
        su AS (
            SELECT q.query_source.genie_space_id AS space_id,
                   COUNT(DISTINCT q.executed_by) AS users
            FROM system.query.history q
            WHERE q.start_time >= date_trunc('MONTH', current_timestamp())
              AND q.query_source.genie_space_id IS NOT NULL{qsf}
            GROUP BY 1),
        wt AS (
            SELECT q.compute.warehouse_id AS wh, date_trunc('HOUR', q.start_time) AS hr,
                   SUM(q.total_task_duration_ms) AS task_ms
            FROM system.query.history q
            WHERE q.start_time >= date_trunc('MONTH', current_timestamp()){qsf}
            GROUP BY 1, 2),
        wc AS (
            SELECT u.usage_metadata.warehouse_id AS wh,
                   date_trunc('HOUR', u.usage_start_time) AS hr,
                   SUM(u.usage_quantity*lp.pricing.effective_list.default) AS usd
            FROM system.billing.usage u
            LEFT JOIN system.billing.list_prices lp ON u.cloud=lp.cloud AND u.sku_name=lp.sku_name
             AND u.usage_start_time>=lp.price_start_time AND (lp.price_end_time IS NULL OR u.usage_start_time<lp.price_end_time)
            WHERE u.usage_date >= date_trunc('MONTH', current_date())
              AND u.usage_metadata.warehouse_id IS NOT NULL{wsf}
            GROUP BY 1, 2)
        SELECT g.space_id,
               SUM(g.queries)                                            AS queries,
               ANY_VALUE(su.users)                                       AS users,
               ROUND(SUM(g.task_ms) / 1000)                              AS task_s,
               -- Hour denominator floored at one compute-hour: near-idle
               -- hours mostly stay unattributed (see OBO attribution note).
               ROUND(SUM(COALESCE(wc.usd, 0) * g.task_ms / GREATEST(wt.task_ms, 3600000)), 2) AS est_warehouse_usd
        FROM g
        JOIN wt ON g.wh = wt.wh AND g.hr = wt.hr
        LEFT JOIN wc ON g.wh = wc.wh AND g.hr = wc.hr
        LEFT JOIN su ON g.space_id = su.space_id
        GROUP BY g.space_id
        ORDER BY est_warehouse_usd DESC
        LIMIT 30""", "system.query.history (genie spaces)")
    out = []
    for r in rows:
        sid = str(r.get("space_id") or "")
        out.append({
            "space_id": sid,
            "title": _genie_space_title(sid),
            "queries": int(_f(r.get("queries"))),
            "users": int(_f(r.get("users"))),
            "task_s": int(_f(r.get("task_s"))),
            "est_warehouse_usd": round(_f(r.get("est_warehouse_usd")), 2),
        })
    return out


# Best-practices reference for the Apps $ checks:
# https://docs.databricks.com/aws/en/dev-tools/databricks-apps/best-practices
# ---------------------------------------------------------------------------
# Caller attribution — warehouse compute driven by apps, both modes:
#   * on-behalf-of: every statement an app submits with a forwarded user token
#     is logged as a databrickssql.commandSubmit audit event (verbose audit
#     logging) whose identity_metadata.acting_resource names the app's OAuth
#     integration and whose commandId is the query-history statement id;
#     run_as stays the human — permissions are untouched.
#   * service-principal: statements executed directly by an SP appear in
#     query.history.executed_by (job runs excluded).
# Allocation is hour-matched with a one-compute-hour floor — see
# _obo_warehouse_attribution. Fully out-of-the-box: nothing app-side.
# ---------------------------------------------------------------------------
def _decl_keys(res: dict[str, Any]) -> list[str]:
    """Dedup keys for dedicatable declared resources (endpoints, vector
    search, Lakebase instances, jobs) — used to detect multi-app declarations."""
    if "serving_endpoint" in res:
        return [f"ep:{res['serving_endpoint'].get('name')}"]
    if "vector_search_endpoint" in res:
        return [f"ep:{res['vector_search_endpoint'].get('name')}"]
    if "vector_search_index" in res:
        return [f"ep:{res['vector_search_index'].get('name')}"]
    if "database" in res:
        return [f"db:{res['database'].get('instance_name')}"]
    if "job" in res:
        return [f"job:{res['job'].get('id')}"]
    return []


def _lakebase_instance_costs(warehouse_id: str) -> dict[str, float]:
    """Full month-to-date cost per Lakebase instance NAME, for apps that
    declare a database binding. Billing identifies instances only by project
    uuid; the name→uuid map comes from the Database Instances API read AS THE
    APP (metadata of app resource bindings — instance creation emits no
    workspace audit event, so there is no system-table path). Instances the
    app's service principal can't see stay unmapped → their chips remain
    "not attributable"."""
    from data.runtime import _app_client

    try:
        instances = list(_app_client().database.list_database_instances())
        uid_by_name = {str(i.name): str(i.uid) for i in instances if i.name and i.uid}
    except Exception:
        return {}
    if not uid_by_name:
        return {}
    uid_list = ", ".join(f"'{_f_safe(u)}'" for u in uid_by_name.values())
    try:
        rows = _run(warehouse_id, f"""
            SELECT usage_metadata.project_id AS uid,
                   SUM(u.usage_quantity*lp.pricing.effective_list.default) AS usd
            FROM system.billing.usage u
            LEFT JOIN system.billing.list_prices lp ON u.cloud=lp.cloud AND u.sku_name=lp.sku_name
             AND u.usage_start_time>=lp.price_start_time AND (lp.price_end_time IS NULL OR u.usage_start_time<lp.price_end_time)
            WHERE u.usage_date >= date_trunc('MONTH', current_date())
              AND usage_metadata.project_id IN ({uid_list}){_ws_scope_sql(warehouse_id)}
            GROUP BY 1""", "system.billing.usage (Lakebase instances)")
    except LiveError:
        return {}
    usd_by_uid = {str(r.get("uid")): round(_f(r.get("usd")), 2) for r in rows}
    return {name: usd_by_uid.get(uid, 0.0) for name, uid in uid_by_name.items()}


def _f_safe(v: str) -> str:
    """uuid-shaped values only — refuse anything that couldn't be one."""
    s = str(v)
    if not all(c in "0123456789abcdefABCDEF-" for c in s) or len(s) > 64:
        raise LiveError("lakebase costs", f"unexpected instance uid: {s[:40]!r}")
    return s


def _obo_integration_names(warehouse_id: str) -> dict[str, str]:
    """{integration_id: name} from the audit event that created each OAuth
    custom app integration — automatic naming while audit retention (365d)
    still covers the creation; operator labels handle the rest."""
    try:
        rows = _run(warehouse_id, """
            SELECT regexp_extract(response.result, '"integration_id":"([0-9a-fA-F-]+)"', 1) AS iid,
                   request_params['name'] AS name
            FROM system.access.audit
            WHERE service_name = 'oauth2' AND action_name = 'createCustomAppIntegration'
              AND event_time >= dateadd(DAY, -365, current_timestamp())
              AND response.result LIKE '%integration_id%'""",
            "system.access.audit (oauth integrations)")
    except LiveError:
        return {}
    return {str(r.get("iid")): str(r.get("name") or "")
            for r in rows if r.get("iid") and r.get("name")}


def _obo_warehouse_attribution(warehouse_id: str) -> dict[str, Any]:
    """Month-to-date warehouse compute per APP CALLER IDENTITY, hour-matched
    (each billed warehouse-hour split by that hour's task-time; hours without
    the caller's statements cost it nothing). TWO identity sources, so both
    app modes are covered:
      * on-behalf-of (kind "obo"): verbose-audit commandSubmit events carry
        the app's OAuth integration as acting_resource + the statement id;
      * service-principal (kind "sp"): statements executed directly BY a
        service principal (query.history.executed_by, job runs excluded) —
        the default for apps that don't forward user tokens.
    Identity ids are prefixed int:/sp: and named via audit auto-names or
    operator labels."""
    wsf = _ws_scope_sql(warehouse_id, "a.workspace_id")
    qsf = _ws_scope_sql(warehouse_id, "q.workspace_id")
    joined = _run(warehouse_id, f"""
        WITH cmds AS (
            SELECT regexp_extract(a.identity_metadata.acting_resource,
                                  'custom-app-integrations/([0-9a-fA-F-]+)', 1) AS iid,
                   a.request_params['commandId'] AS sid,
                   a.identity_metadata.run_as AS run_as
            FROM system.access.audit a
            WHERE a.service_name = 'databrickssql' AND a.action_name = 'commandSubmit'
              AND a.event_date >= date_trunc('MONTH', current_date())
              AND a.identity_metadata.acting_resource LIKE '%custom-app-integrations/%'
              AND a.request_params['commandId'] IS NOT NULL{wsf}
        ),
        st AS (
            SELECT CONCAT('int:', c.iid) AS ident, 'obo' AS kind,
                   q.compute.warehouse_id AS wh,
                   date_trunc('HOUR', q.start_time) AS hr,
                   SUM(q.total_task_duration_ms) AS task_ms,
                   COUNT(*) AS statements
            FROM cmds c
            JOIN system.query.history q ON q.statement_id = c.sid
            WHERE q.start_time >= dateadd(DAY, -1, date_trunc('MONTH', current_date()))
              AND c.iid IS NOT NULL AND c.iid <> ''
            GROUP BY 1, 2, 3, 4

            UNION ALL

            SELECT CONCAT('sp:', q.executed_by) AS ident, 'sp' AS kind,
                   q.compute.warehouse_id AS wh,
                   date_trunc('HOUR', q.start_time) AS hr,
                   SUM(q.total_task_duration_ms) AS task_ms,
                   COUNT(*) AS statements
            FROM system.query.history q
            WHERE q.start_time >= date_trunc('MONTH', current_date())
              AND q.executed_by RLIKE '^[0-9a-f]{{8}}-[0-9a-f]{{4}}-[0-9a-f]{{4}}-[0-9a-f]{{4}}-[0-9a-f]{{12}}$'
              AND q.query_source.job_info.job_id IS NULL{qsf}
            GROUP BY 1, 2, 3, 4
        ),
        app_users AS (
            SELECT CONCAT('int:', iid) AS ident, COUNT(DISTINCT run_as) AS users
            FROM cmds WHERE iid IS NOT NULL AND iid <> '' GROUP BY 1
        ),
        hr_task AS (
            SELECT q.compute.warehouse_id AS wh, date_trunc('HOUR', q.start_time) AS hr,
                   SUM(q.total_task_duration_ms) AS task_ms
            FROM system.query.history q
            WHERE q.start_time >= date_trunc('MONTH', current_date())
              AND q.compute.warehouse_id IN (SELECT DISTINCT wh FROM st)
            GROUP BY 1, 2
        ),
        hr_usd AS (
            SELECT u.usage_metadata.warehouse_id AS wh,
                   date_trunc('HOUR', u.usage_start_time) AS hr,
                   SUM(u.usage_quantity*lp.pricing.effective_list.default) AS usd
            FROM system.billing.usage u
            LEFT JOIN system.billing.list_prices lp ON u.cloud=lp.cloud AND u.sku_name=lp.sku_name
             AND u.usage_start_time>=lp.price_start_time AND (lp.price_end_time IS NULL OR u.usage_start_time<lp.price_end_time)
            WHERE u.usage_date >= date_trunc('MONTH', current_date())
              AND u.usage_metadata.warehouse_id IN (SELECT DISTINCT wh FROM st)
            GROUP BY 1, 2
        )
        SELECT s.ident, s.kind, s.wh,
               -- Denominator floored at ONE COMPUTE-HOUR (3.6e6 task-ms): a
               -- warehouse-hour offers at least that much capacity, so a
               -- caller with seconds of work in a near-idle hour is charged
               -- seconds' worth — idle burn stays UNATTRIBUTED instead of
               -- landing on whoever pinged the warehouse.
               SUM(COALESCE(h.usd, 0) * s.task_ms / GREATEST(t.task_ms, 3600000)) AS usd,
               SUM(s.statements) AS statements,
               ANY_VALUE(au.users) AS users
        FROM st s
        JOIN hr_task t ON t.wh = s.wh AND t.hr = s.hr
        LEFT JOIN hr_usd h ON h.wh = s.wh AND h.hr = s.hr
        LEFT JOIN app_users au ON au.ident = s.ident
        GROUP BY 1, 2, 3""", "system.access.audit × query.history (app callers, hourly)")

    per_id: dict[str, dict[str, Any]] = {}
    for r in joined:
        ident, kind, wh = str(r.get("ident")), str(r.get("kind")), str(r.get("wh"))
        e = per_id.setdefault(ident, {
            "integration_id": ident.split(":", 1)[1], "kind": kind,
            "usd": 0.0, "statements": 0, "users": 0, "warehouses": []})
        e["usd"] += _f(r.get("usd"))
        e["statements"] += int(_f(r.get("statements")))
        e["users"] = max(e["users"], int(_f(r.get("users"))))
        e["warehouses"].append(wh)
    rows = sorted(per_id.values(), key=lambda x: -x["usd"])
    for e in rows:
        e["usd"] = round(e["usd"], 2)
        e["warehouses"] = sorted(set(e["warehouses"]))
    return {"rows": rows, "total_usd": round(sum(e["usd"] for e in rows), 2)}



def apps_cost_live(warehouse_id: str) -> dict[str, Any]:
    """Apps $ — every Databricks App the viewer can see: month-to-date compute
    cost + runtime from billing (billing_origin_product='APPS';
    usage_metadata.app_id/app_name; one row ≈ one compute-hour), declared
    resource assets from the Apps API with month-to-date cost where billing
    can attribute them, and deterministic best-practice flags."""
    wsf = _ws_scope_sql(warehouse_id)
    bill = _run(warehouse_id, f"""
        SELECT usage_metadata.app_id  AS app_id,
               usage_metadata.app_name AS app_name,
               SUM(u.usage_quantity*lp.pricing.effective_list.default) AS usd,
               SUM(u.usage_quantity) AS dbus,
               SUM(unix_timestamp(u.usage_end_time) - unix_timestamp(u.usage_start_time)) / 3600 AS runtime_h,
               CAST(MAX(u.usage_end_time) AS STRING) AS last_billed,
               any_value(CAST(u.workspace_id AS STRING)) AS ws,
               any_value(u.cloud) AS cloud
        FROM system.billing.usage u
        LEFT JOIN system.billing.list_prices lp ON u.cloud=lp.cloud AND u.sku_name=lp.sku_name
         AND u.usage_start_time>=lp.price_start_time AND (lp.price_end_time IS NULL OR u.usage_start_time<lp.price_end_time)
        WHERE u.billing_origin_product = 'APPS'
          AND u.usage_date >= date_trunc('MONTH', current_date()){wsf}
        GROUP BY 1, 2""", "system.billing.usage (apps)")
    bill_by_name = {str(r.get("app_name") or ""): r for r in bill}

    # Asset cost lookups (month-to-date, scoped): warehouses by id, serving /
    # vector-search endpoints by name, jobs by id, genie spaces via the
    # per-space warehouse-compute attribution, Lakebase instances via the
    # name→billing-project map (_lakebase_instance_costs).
    wh_usd: dict[str, float] = {}
    ep_usd: dict[str, float] = {}
    try:
        wh_usd = {str(r.get("wh")): round(_f(r.get("usd")), 2) for r in _run(warehouse_id, f"""
            SELECT u.usage_metadata.warehouse_id AS wh,
                   SUM(u.usage_quantity*lp.pricing.effective_list.default) AS usd
            FROM system.billing.usage u
            LEFT JOIN system.billing.list_prices lp ON u.cloud=lp.cloud AND u.sku_name=lp.sku_name
             AND u.usage_start_time>=lp.price_start_time AND (lp.price_end_time IS NULL OR u.usage_start_time<lp.price_end_time)
            WHERE u.usage_date >= date_trunc('MONTH', current_date())
              AND u.usage_metadata.warehouse_id IS NOT NULL{wsf}
            GROUP BY 1""", "system.billing.usage (warehouse cost)")}
        ep_usd = {str(r.get("ep")): round(_f(r.get("usd")), 2) for r in _run(warehouse_id, f"""
            SELECT u.usage_metadata.endpoint_name AS ep,
                   SUM(u.usage_quantity*lp.pricing.effective_list.default) AS usd
            FROM system.billing.usage u
            LEFT JOIN system.billing.list_prices lp ON u.cloud=lp.cloud AND u.sku_name=lp.sku_name
             AND u.usage_start_time>=lp.price_start_time AND (lp.price_end_time IS NULL OR u.usage_start_time<lp.price_end_time)
            WHERE u.usage_date >= date_trunc('MONTH', current_date())
              AND u.usage_metadata.endpoint_name IS NOT NULL{wsf}
            GROUP BY 1""", "system.billing.usage (endpoint cost)")}
    except LiveError:
        pass  # asset $ columns degrade to unattributed; the app rows still serve
    space_usd = {s["space_id"]: s["est_warehouse_usd"] for s in _genie_space_costs(warehouse_id)}
    # Declared JOBS: billing splits per job_id, so a declared job's FULL cost
    # is attributable (marked "full" — overstated if others also run the job).
    job_usd: dict[str, float] = {}
    try:
        job_usd = {str(r.get("j")): round(_f(r.get("usd")), 2) for r in _run(warehouse_id, f"""
            SELECT CAST(u.usage_metadata.job_id AS STRING) AS j,
                   SUM(u.usage_quantity*lp.pricing.effective_list.default) AS usd
            FROM system.billing.usage u
            LEFT JOIN system.billing.list_prices lp ON u.cloud=lp.cloud AND u.sku_name=lp.sku_name
             AND u.usage_start_time>=lp.price_start_time AND (lp.price_end_time IS NULL OR u.usage_start_time<lp.price_end_time)
            WHERE u.usage_date >= date_trunc('MONTH', current_date())
              AND u.usage_metadata.job_id IS NOT NULL{wsf}
            GROUP BY 1""", "system.billing.usage (job cost)")}
    except LiveError:
        pass  # job chips degrade to unattributed

    # App identity, creator, deploys, lifecycle and the DECLARED RESOURCES all
    # come from the audit log — createApp/updateApp events carry the full app
    # spec (request_params.app), so no Apps API call (and no extra OAuth
    # scope) is needed.
    audit = _run(warehouse_id, f"""
        WITH ev AS (
            SELECT COALESCE(request_params['app_name'],
                            get_json_object(request_params['app'], '$.name')) AS app_name,
                   action_name,
                   user_identity.email AS actor,
                   event_time,
                   get_json_object(request_params['app'], '$.resources') AS resources_json
            FROM system.access.audit
            WHERE service_name = 'apps'
              AND event_date >= dateadd(DAY, -365, current_date())
              AND action_name IN ('createApp','updateApp','createUpdate','installTemplateApp',
                                  'deployApp','startApp','stopApp','deleteApp')
              {_ws_scope_sql(warehouse_id, "workspace_id")}
        )
        SELECT app_name,
               -- Bundle-managed apps may never emit createApp (the direct
               -- engine uses createUpdate) — fall back to the first event.
               COALESCE(min_by(actor, event_time) FILTER (WHERE action_name = 'createApp'),
                        min_by(actor, event_time))                                      AS creator,
               CAST(COALESCE(MIN(event_time) FILTER (WHERE action_name = 'createApp'),
                             MIN(event_time)) AS STRING)                                AS created,
               CAST(MAX(event_time) FILTER (WHERE action_name IN
                    ('deployApp','createUpdate','updateApp')) AS STRING)                AS last_deploy,
               max_by(action_name, event_time)
                 FILTER (WHERE action_name IN ('startApp','stopApp','deleteApp'))       AS last_lifecycle,
               max_by(resources_json, event_time)
                 FILTER (WHERE action_name IN ('createApp','updateApp','createUpdate','installTemplateApp')
                         AND resources_json IS NOT NULL)                                AS resources_json
        FROM ev
        WHERE app_name IS NOT NULL
        GROUP BY 1""", "system.access.audit (apps)")
    audit_by_name = {str(r.get("app_name") or ""): r for r in audit}

    hours_elapsed = max(1.0, (time.time() - time.mktime(time.strptime(
        time.strftime("%Y-%m-01", time.gmtime()), "%Y-%m-%d"))) / 3600)

    lakebase_usd = _lakebase_instance_costs(warehouse_id)

    # Count how many apps declare each dedicatable resource: full-cost
    # attribution only applies when EXACTLY ONE app declares it — an endpoint
    # or instance declared by several apps can't be "dedicated" to any.
    decl_counts: dict[str, int] = {}
    for a0 in audit_by_name.values():
        try:
            res0 = json.loads(str(a0.get("resources_json") or "[]")) or []
        except ValueError:
            res0 = []
        for res in res0:
            for key in _decl_keys(res):
                decl_counts[key] = decl_counts.get(key, 0) + 1

    def _assets_of(resources: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []

        def _full_or_shared(key: str, usd: float | None) -> tuple[float | None, str | None]:
            """FULL cost only when exactly one app declares the resource;
            otherwise the shared total (not summed into linked $)."""
            if usd is None:
                return None, None
            return usd, ("full" if decl_counts.get(key, 0) == 1 else "shared")

        for res in resources or []:
            if "sql_warehouse" in res:
                # Warehouses stay SHARED regardless: the caller attribution
                # above measures each app's true hour-matched slice.
                wid = str(res["sql_warehouse"].get("id") or "")
                out.append({"type": "warehouse", "label": wid, "usd": wh_usd.get(wid), "attribution": "shared"})
            elif "serving_endpoint" in res:
                name = str(res["serving_endpoint"].get("name") or "")
                # databricks-* = Databricks-hosted pay-per-token endpoints:
                # estate-shared by nature (they bill for EVERYONE's tokens),
                # so never full-cost regardless of who declares them.
                if name.startswith("databricks-"):
                    usd, attr = ep_usd.get(name), "shared"
                else:
                    usd, attr = _full_or_shared(f"ep:{name}", ep_usd.get(name))
                out.append({"type": "serving endpoint", "label": name, "usd": usd, "attribution": attr})
            elif "vector_search_endpoint" in res or "vector_search_index" in res:
                key = "vector_search_endpoint" if "vector_search_endpoint" in res else "vector_search_index"
                name = str(res[key].get("name") or res[key].get("endpoint_name") or "")
                if name.startswith("databricks-"):
                    usd, attr = ep_usd.get(name), "shared"
                else:
                    usd, attr = _full_or_shared(f"ep:{name}", ep_usd.get(name))
                out.append({"type": "vector search", "label": name, "usd": usd, "attribution": attr})
            elif "genie_space" in res:
                sid = str(res["genie_space"].get("space_id") or "")
                out.append({"type": "genie space", "label": sid, "usd": space_usd.get(sid), "attribution": "app"})
            elif "database" in res:
                d = res["database"]
                inst = str(d.get("instance_name") or "")
                usd, attr = _full_or_shared(f"db:{inst}", lakebase_usd.get(inst))
                out.append({"type": "database",
                            "label": f"{inst}/{d.get('database_name')}",
                            "usd": usd, "attribution": attr})
            elif "secret" in res:
                s = res["secret"]
                out.append({"type": "secret", "label": f"{s.get('scope')}/{s.get('key')}", "usd": None, "attribution": None})
            elif "uc_securable" in res:
                out.append({"type": "uc table", "label": str(res["uc_securable"].get("securable_full_name") or ""), "usd": None, "attribution": None})
            elif "job" in res:
                jid = str(res["job"].get("id") or "")
                usd, attr = _full_or_shared(f"job:{jid}", job_usd.get(jid))
                out.append({"type": "job", "label": jid, "usd": usd, "attribution": attr})
            else:
                kind = next((k for k in res if k != "name"), "resource")
                out.append({"type": kind.replace("_", " "), "label": str(res.get("name") or ""), "usd": None, "attribution": None})
        return out

    apps_out: list[dict[str, Any]] = []
    stale_cutoff = time.strftime("%Y-%m-%d", time.gmtime(time.time() - 30 * 86400))
    now_s = time.time()
    all_names = set(bill_by_name) | set(audit_by_name)
    for name in sorted(n for n in all_names if n):
        b = bill_by_name.get(name, {})
        a = audit_by_name.get(name, {})
        runtime_h = round(_f(b.get("runtime_h")), 1)
        uptime = min(1.0, runtime_h / hours_elapsed)
        try:
            resources = json.loads(str(a.get("resources_json") or "[]")) or []
        except ValueError:
            resources = []
        assets = _assets_of(resources)
        # Derived state: deleted/stopped from the last lifecycle event; running
        # when billing shows compute hours in the last ~3 hours.
        last_billed = str(b.get("last_billed") or "")
        billed_recently = False
        try:
            # billing ingestion lags hours behind — use a generous window
            billed_recently = (now_s - time.mktime(time.strptime(last_billed[:19], "%Y-%m-%dT%H:%M:%S"))) < 8 * 3600
        except ValueError:
            try:
                billed_recently = (now_s - time.mktime(time.strptime(last_billed[:19], "%Y-%m-%d %H:%M:%S"))) < 8 * 3600
            except ValueError:
                pass
        lifecycle = str(a.get("last_lifecycle") or "")
        if lifecycle == "deleteApp":
            state = "DELETED"
        elif billed_recently:
            state = "RUNNING"
        elif lifecycle == "stopApp":
            state = "STOPPED"
        else:
            state = "IDLE"
        last_deploy = str(a.get("last_deploy") or "")[:10]
        flags: list[str] = []
        if uptime >= 0.95 and state not in ("DELETED", "STOPPED"):
            flags.append("always-on")
            if last_deploy and last_deploy < stale_cutoff:
                flags.append("stale & running")
        if not resources and a:
            flags.append("no resource bindings")
        if not a:
            flags.append("no audit history (created >1y ago?)")
        ws_id = str(b.get("ws") or "")
        cloud = str(b.get("cloud") or "")
        url = f"https://{name}-{ws_id}.aws.databricksapps.com" if (ws_id and cloud == "AWS") else ""
        apps_out.append({
            "name": name, "app_id": str(b.get("app_id") or ""), "url": url,
            "state": state, "creator": str(a.get("creator") or ""),
            "created": str(a.get("created") or "")[:10], "updated": last_deploy,
            "cost_usd": round(_f(b.get("usd")), 2), "dbus": round(_f(b.get("dbus")), 1),
            "runtime_h": runtime_h, "uptime_pct": round(uptime, 3),
            "assets": assets,
            "assets_usd": round(sum(x["usd"] for x in assets if x.get("usd") and x.get("attribution") == "app"), 2),
            "assets_shared_usd": round(sum(x["usd"] for x in assets if x.get("usd") and x.get("attribution") == "shared"), 2),
            "flags": flags,
        })
    apps_out.sort(key=lambda x: -x["cost_usd"])

    # Caller attribution — one row per identity (OAuth integration for OBO,
    # service principal for SP mode); named from the integration's creation
    # audit event, overridden by operator labels.
    try:
        obo = _obo_warehouse_attribution(warehouse_id)
        obo_error = None
    except LiveError as e:
        obo = {"rows": [], "total_usd": 0.0}
        obo_error = f"{e.source}: {e.detail}"
    auto_names = _obo_integration_names(warehouse_id) if obo["rows"] else {}
    labels = app_identity_labels(warehouse_id) if obo["rows"] else {}
    by_name: dict[str, dict[str, Any]] = {}
    for r in obo["rows"]:
        label = labels.get(r["integration_id"], "")
        auto = auto_names.get(r["integration_id"], "")
        r["name"] = label or auto
        r["name_source"] = "label" if label else ("audit" if auto else "")
        if r["name"]:
            by_name[r["name"]] = r
    for a in apps_out:
        m = by_name.get(a["name"])
        a["obo_usd"] = m["usd"] if m else 0.0
        # Full OBO detail for the row's expanded breakdown.
        a["obo"] = ({"usd": m["usd"], "statements": m["statements"],
                     "users": m["users"], "warehouses": m["warehouses"]}
                    if m else None)
        # "Full-cost" assets (Lakebase instances, declared jobs): the whole
        # resource cost is carried by the declaring app — marked with an
        # asterisk in the UI because it overstates when the resource is shared.
        a["full_usd"] = round(sum(x["usd"] for x in a["assets"]
                                  if x.get("usd") and x.get("attribution") == "full"), 2)
        # ONE attributed number per app: OBO warehouse compute + genie-space
        # compute + full-cost assets. Shared resource totals stay out (the
        # OBO figure IS the app's slice of those warehouses).
        a["linked_usd"] = round(a["assets_usd"] + a["obo_usd"] + a["full_usd"], 2)

    return {
        "month": time.strftime("%Y-%m", time.gmtime()),
        "summary": {
            "total_usd": round(sum(x["cost_usd"] for x in apps_out), 2),
            "num_apps": len(apps_out),
            "num_running": sum(1 for x in apps_out if x["state"] == "RUNNING"),
            "runtime_h": round(sum(x["runtime_h"] for x in apps_out), 1),
            "assets_usd": round(sum(x["assets_usd"] for x in apps_out), 2),
            "assets_shared_usd": round(sum(x["assets_shared_usd"] for x in apps_out), 2),
            "obo_usd": obo["total_usd"],
            "full_usd": round(sum(x["full_usd"] for x in apps_out), 2),
            # Attributed spend LINKED to apps: caller warehouse compute, both
            # modes (incl. identities not matched to an app row) + genie-space
            # compute + full-cost assets (asterisked).
            "linked_usd": round(sum(x["assets_usd"] + x["full_usd"] for x in apps_out)
                                + obo["total_usd"], 2),
        },
        "apps": apps_out,
        "obo": {
            "rows": obo["rows"],
            "total_usd": obo["total_usd"],
            "error": obo_error,
        },
        "caveats": [
            "Everything on this page comes from system tables — no Apps API call and no extra OAuth scope. Cost + runtime: system.billing.usage (billing_origin_product = 'APPS'; one row ≈ one compute-hour; app compute bills every hour the app is RUNNING, visited or not). Creator, last deploy, lifecycle and declared resources: system.access.audit apps events (createApp/updateApp carry the full app spec).",
            "State is DERIVED: DELETED/STOPPED from the last lifecycle audit event, RUNNING when compute billed within the last ~3 hours, IDLE otherwise. Apps created more than a year ago may have no audit history left (365-day retention).",
            "Visitors per app are not measurable: there is no system.apps schema and the apps audit service logs lifecycle events only (deploy/start/stop), not requests — so no visitor column is shown rather than an invented one.",
            "Asset attribution was checked, not assumed: genie-space figures ARE app-attributable (query_source.genie_space_id). Warehouse chips always show the SHARED total — the caller attribution below measures each app's true slice instead. Serving / vector-search endpoints, Lakebase instances and declared jobs are attributed at FULL cost (asterisked) only when EXACTLY ONE app declares them; declared by several apps ⇒ shared. Databricks-hosted pay-per-token endpoints (databricks-*) are always shared — they bill for everyone's tokens. Secrets and tables carry no attributable billing. The resource list reflects the app spec at its last create/update event.",
            "OBO warehouse compute IS attributable (the card below): every statement an app submits with a forwarded user token is audited as databrickssql.commandSubmit with identity_metadata.acting_resource = the app's OAuth integration and the statement id. Allocation is HOUR-MATCHED: each billed warehouse-hour is split by that hour's task-time shares (denominator floored at one compute-hour, so a caller with seconds of work in a near-idle hour is charged seconds' worth), and an app is charged only in hours where it actually ran statements — idle burn stays unattributed. Requires VERBOSE audit logging; run_as stays the human, so permissions are untouched. Serving calls made on behalf of users remain unattributable (the serving data plane records only the human requester) — dedicated endpoints are the answer there.",
            "Full-cost assets (asterisked): a serving/vector-search endpoint, Lakebase instance or job declared by exactly one app carries its FULL month-to-date cost on that app — billing cannot split these by caller, so the figure overstates whenever the resource is also used from outside apps. Lakebase name→billing mapping is read as the app's own service principal; instances it cannot see stay unattributed.",
            "The caller-attribution card covers BOTH app modes: on-behalf-of statements via the audit identity chain, and service-principal statements straight from query history (job runs excluded). SP callers appear unnamed until labeled — jobs' and other services' principals can show up too, so only label the ones you recognise as apps.",
            "Best-practice flags follow docs.databricks.com → Databricks Apps → Best practices: stop always-on apps that are no longer used, and prefer managed resource bindings over hard-coded credentials.",
        ],
    }


@_ttl_cache(600)
def genie_cost_live(warehouse_id: str, workspace: str | None = None) -> dict[str, Any]:
    """Genie cost by surface/user/workspace this month — billing tables ONLY,
    USD list price (billing carries no discount/commitment data). The estate
    view also attributes per-space warehouse compute from query history."""
    raw = _run(warehouse_id, _GENIE_GROUND_TRUTH_SQL.format(ws_scope=_ws_scope_sql(warehouse_id)),
               "system.billing.usage (Genie)")
    gt_rows: list[dict[str, Any]] = []
    for r in raw:
        surface = str(r.get("surface") or "UNKNOWN")
        month = str(r.get("usage_month") or "")
        gt_rows.append({
            "usage_month": month,
            "workspace": str(r.get("workspace") or ""),
            "user_identity": str(r.get("user_identity") or ""),
            "surface": surface,
            "label": genie_cost.surface_label(surface),
            "total_dbus": round(_f(r.get("total_dbus")), 1),
            "total_list_cost_usd": round(_f(r.get("total_list_cost")), 2),
        })
    payload = genie_cost.assemble(gt_rows, workspace)
    # Per-space warehouse-compute attribution only on the estate view (the
    # cached page payload) — drill-down variants skip the extra scan.
    payload["by_space"] = _genie_space_costs(warehouse_id) if workspace in (None, "", "all") else []
    return payload


# ---------------------------------------------------------------------------
# AI $ — all AI billing products (queries.sql AI aggregation).
# ---------------------------------------------------------------------------
_AI_SQL = """
SELECT
  COALESCE(u.usage_metadata.endpoint_name, u.usage_metadata.app_name, CONCAT('(', u.billing_origin_product, ')')) AS name,
  u.billing_origin_product                                    AS product,
  CAST(u.workspace_id AS STRING)                              AS workspace,
  COALESCE(u.identity_metadata.run_as, u.identity_metadata.created_by, 'shared') AS owner,
  MAX(u.product_features.model_serving.offering_type)         AS ms_offering,
  MAX(CASE WHEN u.product_features.serverless_gpu.workload_type IS NOT NULL THEN 1 ELSE 0 END) AS gpu,
  SUM(u.usage_quantity)                                       AS dbus,
  SUM(u.usage_quantity * lp.pricing.effective_list.default)   AS list_cost
FROM system.billing.usage u
LEFT JOIN system.billing.list_prices lp
  ON u.cloud = lp.cloud AND u.sku_name = lp.sku_name
 AND u.usage_start_time >= lp.price_start_time
 AND (lp.price_end_time IS NULL OR u.usage_start_time < lp.price_end_time)
WHERE u.billing_origin_product IN ('MODEL_SERVING','AI_GATEWAY','VECTOR_SEARCH','AGENT_BRICKS','AI_FUNCTIONS','FOUNDATION_MODEL_TRAINING')
  AND u.usage_date >= date_trunc('MONTH', current_date()){ws_scope}
GROUP BY 1, 2, 3, 4
HAVING SUM(u.usage_quantity) > 0
"""

_AI_MODE = {  # model_serving.offering_type -> friendly billing mode
    "PROVISIONED_THROUGHPUT": "Provisioned",
    "PAY_PER_TOKEN": "Pay-per-token",
}


@_ttl_cache(600)
def ai_cost_live(warehouse_id: str, workspace: str | None = None) -> dict[str, Any]:
    """Real AI spend by product/endpoint/owner/workspace this month — USD
    list price straight from billing, plus the real 6-month trend."""
    raw = _run(warehouse_id, _AI_SQL.format(ws_scope=_ws_scope_sql(warehouse_id)),
               "system.billing.usage (AI)")
    rows: list[dict[str, Any]] = []
    for r in raw:
        product = str(r.get("product") or "")
        rows.append({
            "name": str(r.get("name") or "(unknown)"),
            "product": product,
            "product_label": ai_cost.PRODUCT_LABEL.get(product, product.title().replace("_", " ")),
            "workspace": str(r.get("workspace") or ""),
            "owner": str(r.get("owner") or "shared"),
            "dbus_month": round(_f(r.get("dbus")), 1),
            "list_usd_month": round(_f(r.get("list_cost")), 2),
            "mode": _AI_MODE.get(str(r.get("ms_offering") or ""), "Standard"),
            "gpu": bool(_f(r.get("gpu"))),
        })
    rows.sort(key=lambda r: -r["list_usd_month"])
    # 6-month AI-spend trend straight from billing.
    tr = _run(warehouse_id, f"""
        SELECT date_format(u.usage_date, 'yyyy-MM') AS m,
               SUM(u.usage_quantity * lp.pricing.effective_list.default) AS usd
        FROM system.billing.usage u
        LEFT JOIN system.billing.list_prices lp
          ON u.cloud = lp.cloud AND u.sku_name = lp.sku_name
         AND u.usage_start_time >= lp.price_start_time
         AND (lp.price_end_time IS NULL OR u.usage_start_time < lp.price_end_time)
        WHERE u.billing_origin_product IN ('MODEL_SERVING','AI_GATEWAY','VECTOR_SEARCH','AGENT_BRICKS','AI_FUNCTIONS','FOUNDATION_MODEL_TRAINING')
          AND u.usage_date >= add_months(date_trunc('MONTH', current_date()), -5){_ws_scope_sql(warehouse_id)}
        GROUP BY 1 ORDER BY 1""", "system.billing.usage (AI trend)")
    trend = {"months": [str(r.get("m")) for r in tr],
             "points": [round(_f(r.get("usd"))) for r in tr]}
    return ai_cost.assemble(rows, workspace, trend)
