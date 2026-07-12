# FinOps Command Center

A Databricks App that turns the account's system tables into a cost-control
command center: spend, cost drivers, workspaces, query analytics, table
optimisation, access governance, tag coverage, Genie/AI/Apps cost
attribution, data-quality monitors and a recommendations hub — all live
data, no samples.

## Pages


| Tab                     | Source                                                                        | What it shows                                                                                                                                                                                                                         |
| ----------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview                | `system.billing.usage` × `list_prices`                                        | Estate spend, weekly trend, complexity mix, worst open best-practice check per workspace                                                                                                                                              |
| Access                  | `system.information_schema.*_privileges`                                      | Direct grants by object / by principal + deterministic risk flags                                                                                                                                                                     |
| Workspaces              | billing                                                                       | Per-workspace spend/DBUs, best-practice checks (health) and drill-down                                                                                                                                                                |
| Query Advisor           | `system.query.history`                                                        | Per-statement classification (capacity, spill, full-scan, slow, healthy) with wall-time phase breakdown and on-demand AI reviews, mirrored in the app store                                                                           |
| Tables                  | `information_schema.tables` + lineage + PO history + `DESCRIBE DETAIL` probes | UC inventory + measured layout health of the most-read tables (size, files, clustering, best-practice flags); HMS flagged for migration                                                                                               |
| Governance              | billing + `system.compute` + tables                                           | Scored tiles: tagging, UC adoption, serverless/jobs share, compute hygiene, access flags                                                                                                                                              |
| Tags                    | billing `custom_tags` + `information_schema.*_tags`                           | Coverage by product, every key's spend, per-tag search: resources + securables + cost                                                                                                                                                 |
| Adoption & Value        | billing + query history + lineage                                             | MAU/WAU, product breadth, top users, which curated tables are read                                                                                                                                                                    |
| Genie $ / AI $ / Apps $ | billing (+ audit + query history for apps)                                    | Genie spend by surface/user + hour-matched per-space compute; AI-product spend; per-app cost, runtime, resources, flags + caller attribution of warehouse compute (on-behalf-of and service-principal) and full-cost dedicated assets |
| Data Quality            | `information_schema` + billing (+ optional `system.data_quality_monitoring`)  | Monitors discovered from their output tables, refresh freshness, monitoring spend; quality statuses when the optional grant is held                                                                                                   |
| Recommendations         | derived                                                                       | Findings composed from the other pages, scored by priority                                                                                                                                                                            |
| Configuration (gear)    | app store                                                                     | Page/data-source guide, cached-object admin, workspace scope, access-rule definitions, theme                                                                                                                                          |


Ask Genie (banner) streams answers from the bundle-managed Genie space
(`resources/finops_genie_space.json`).

## Deploy

Deployment is a Databricks Asset Bundle (`databricks.yml`, direct engine).

**Option 1 — from the workspace UI (preferred, no local tooling):** put the
repo in a Git folder, set the ONE required value — the warehouse id in
`databricks.yml` (`variables.warehouse_id.default`; everything else has
working defaults) — and use the bundle panel (Deploy → ▶ on the `finops`
app). See `docs/DEPLOYMENT.md` § "Deploy from the workspace".

**Option 2 — local CLI:**

```bash
# 1. Edit customise.yaml (customer name, warehouse, app catalog/schema, …)
# 2. One command:
./deploy.sh --profile <PROFILE>
```

`deploy.sh` = `databricks bundle deploy` + `databricks bundle run finops`
after writing the customise.yaml values into `app.yaml`/`config.yaml`. If
`warehouse_id` is blank it lists the workspace's SQL warehouses and asks you
to pick one. `deploy.sh` and `customise*.yaml` exist ONLY for this flow —
the workspace flow never reads them.

Either way the React frontend is built **on the Databricks Apps container**
by `start.sh` — never locally. Full instructions, prerequisites and the
permission model: `docs/DEPLOYMENT.md`.

## Data honesty rules

- Every number is real (system tables at USD list price) or absent — no
invented metrics, no sample fallbacks. Failed reads surface as 503s naming
the object to fix.
- The app writes ONLY to its own state store (`workspace_scope`,
`workspace_universe`, `qa_executions`, `qa_analysis`, `app_cache`,
`tag_exclusions`, `app_identity_map`) — Lakebase Postgres by default, or a
UC schema with `app_store: uc`. 
- Estate reads run on-behalf-of-user: what you see is exactly what your own
Unity Catalog permissions allow. There is no service token; the app's own
credentials touch only its state store (plus one metadata call — listing
Lakebase instances to map their billing for the Apps tab).
- AUD figures are USD list price × the deploy-time `fx_aud` rate (shown next
to the currency switch); the Account Console invoice is authoritative.

