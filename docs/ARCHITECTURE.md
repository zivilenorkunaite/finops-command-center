# Architecture

**Backend** — FastAPI (`app.py`), one process, uvicorn on the Databricks Apps
runtime. The data layer is a layered package under `data/` (imports only
point left; `data/live.py` is the facade `app.py` imports, and it owns the
cache-object registry):

```
runtime → store → cache → feature modules → live (facade)

runtime        viewer-identity contextvars, SQL clients, _run (chunked
               Statement Execution), in-process memo, SQL escaping
store          app-state store (Lakebase/UC) + workspace scope + tag exclusions
cache          the 24h per-viewer object cache, stamped by package content
workspaces     facts, best-practice checks, overview, universe, detail
drivers        cost drivers by product/SKU (run-rate MoM)
advisor        query mirror, rollups, ai_query reviews
tables         inventory + DESCRIBE DETAIL layout health
tags           coverage, key catalog, per-tag search
access         direct grants + deterministic risk rules
governance     scorecard + compute hygiene
adoption       active identities, product breadth, value map
product_costs  Genie $ / AI $ / Apps $
dqm            data-quality monitors (three honest layers)
hub            recommendations composed from the cached objects
health         viewer preflight
```

All estate access is read-only SQL against the configured warehouse via the
Statement Execution API, fail-closed (a failed read is a 503 naming the
object — never substituted data; the page keeps its layout and lists the
tables it needs).

* Two identities, strictly split:
  * **Estate reads** (system tables, information_schema, HMS listing, Genie,
    `ai_query`) run **on-behalf-of-user** with the forwarded viewer token —
    what a viewer sees is exactly what their own permissions allow. The SQL
    client is built with explicit `auth_type="pat"` because the container
    also carries SP OAuth env vars.
  * **App-state I/O** runs as the **app's own service principal** — viewers
    need no grants on the app's store. The SP's one estate touch: listing
    Lakebase instances/projects (metadata) to map their billing on the Apps
    tab.
* `data/genie_client.py` — Genie Conversation API + query-result fetch;
  answers stream over SSE with keepalives (long scans take minutes).
* `data/config.py` — env > config.yaml > defaults.

**App-state store** (the only writes) — picked by `app_store`:

* `lakebase` (default): a Lakebase managed-Postgres **Autoscaling project**
  (project + branch + endpoint) **created by the bundle**; the app connects
  as its SP via the injected `PG*` env vars (OAuth token as the Postgres
  password). Nothing is created in Unity Catalog.
* `uc`: Delta tables in `app_catalog`.`app_schema`, written with the app's
  credentials (the SP needs USE CATALOG + CREATE SCHEMA there).

| Table | Purpose |
|---|---|
| `workspace_scope` | Included workspaces picked on the Configuration page; empty = all. Every workspace-scoped query inlines its predicate. |
| `workspace_universe` | Stored pick-list (id, spend, DBUs) — rebuilt by the Configuration page's Refresh button (billing scanned as the viewer, stored as the app). |
| `qa_executions` | Incremental mirror of `system.query.history` (watermark ingest — only unprocessed executions are read, as the viewer; text-fingerprinted; ~9-day retention). Carries the wall-time phase breakdown (queue / compute-start / compile / execute / fetch), rows read/returned, result-cache hits and the issuing source (job / dashboard / notebook / Genie) per execution. |
| `qa_analysis` | One `ai_query` SQL review per query fingerprint (Claude endpoint from `llm_endpoint`, model called as the viewer, stored as the app) — background batches costliest-first, or on demand via the row's "Review with AI now" button (`POST /api/queries/analyse`). |
| `tag_exclusions` | Operator-excluded blanket tag keys (Configuration → Tags) — excluded keys don't count as coverage in the Tags/Governance scans. Saves clear the cache. |
| `app_identity_map` | Operator labels naming caller identities (OAuth integrations / service principals) on the Apps tab when the audit window can't name them. |
| `app_cache` | The 24-hour object cache, keyed **(object, principal)**: objects whose loaders read estate data on-behalf-of-user (today: all 16 — overview, workspaces, cost drivers, grants, advisor rollups, tables, table-health probes, tags, governance, adoption, genie/AI/apps/platform spend, data-quality monitors, hub) cache one row PER VIEWER, so permissions are never shared across people; an app-credential loader would cache one `shared` row. Rows carry a code stamp (older-build rows are treated as absent). Stale objects keep serving while a background refresh (run with that viewer's token + identity) rebuilds them; the Configuration page lists every object grouped by tab with its per-user/shared scope and per-object Refresh, and each page carries an "as of / refreshing" badge with its own Refresh button. Scope saves clear it. |

In-process: a short TTL memo still wraps parameterized drill-downs
(per-workspace genie/AI/cost-driver views, workspace detail) and dedupes the
shared billing scan within a refresh burst; scope saves clear it too.

**Frontend** — React 18 + Vite + Tailwind (`frontend/`), typed API client,
zustand store. Built on the app container by `start.sh` (never locally);
`app.py` checks `frontend/dist` per request so the SPA activates without a
restart. Operator surface is the **Configuration page** (gear button, not a
tab): per-tab data-source guide, cached-object admin, workspace scope,
access-rule definitions, and the theme switch.

**Deployment** — Asset Bundle (`databricks.yml`, direct engine): app +
warehouse binding + the Genie space as a `genie_spaces` resource
(`resources/finops_genie_space.json` — neutral filename on purpose; the
`.geniespace.json` suffix would materialise as a Genie node and break app
snapshots, id injected into the app via `valueFrom`) + Lakebase Autoscaling
`postgres_projects`/`postgres_branches`/`postgres_endpoints` resources + the
app's `postgres` binding (provisions the SP's Postgres role). No Unity Catalog table grants are created or modified at
deploy time. Deploy either with `deploy.sh` (= `bundle deploy` + `bundle run
finops`) or entirely from the workspace bundle panel in a Git folder — no
local tooling; `presets.source_linked_deployment: false` keeps the app's
source as real file copies in both flows (docs/DEPLOYMENT.md).
