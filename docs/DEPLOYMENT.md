# Deploying the FinOps Command Center

Deployment is a Databricks Asset Bundle end to end. Pick ONE option:

* **Option 1 — from the workspace UI** (Git folder + bundle panel, no local tooling) — preferred.
* **Option 2 — local CLI** via `./deploy.sh`.

Both create the same four resources: the **App**, the **Genie space**, the
**Lakebase instance** (app-state store) and the **warehouse binding**. The
React frontend always builds on the app container — never on your machine.

### Repo files at a glance

| File | Used by |
|---|---|
| `databricks.yml` | both options — the bundle definition |
| `app.yaml` | both — Apps runtime config (`command: start.sh` + env vars) |
| `config.yaml` | both — runtime defaults read by the app (env vars win) |
| `app.py`, `data/`, `frontend/`, `requirements.txt`, `start.sh` | both — the app itself |
| `resources/finops_genie_space.json` | both — the Genie-space definition |
| `deploy.sh` | **Option 2 only** — writes customise values into `app.yaml`, then `bundle deploy` + `bundle run` |
| `customise.yaml` (+ optional `customise.<customer>.yaml` variants) | **Option 2 only** — deploy.sh's input; the workspace flow never reads it |

---

## 1. Prerequisites — who needs what

### The deployer (you) needs

| Requirement | Why |
|---|---|
| Workspace access with **Git folder** creation (Option 1) or a CLI login (Option 2) | source of the bundle |
| Entitlement to **create Databricks Apps** in the workspace | the `apps` bundle resource |
| Entitlement to **create Lakebase database instances** | the `database_instances` resource (default app store) |
| Ability to **create Genie spaces** | the `genie_spaces` resource |
| **CAN_USE** on the target SQL warehouse | the app's warehouse binding |
| Serverless compute enabled in the workspace (Option 1 only) | the workspace bundle runner requires it |
| Databricks CLI **≥ v1.3.0** (Option 2 only; repo built with v1.7.0) | direct deployment engine + `genie_spaces` |

### Every viewer of the app needs (grant once, per workspace onboarding)

Estate reads run **on-behalf-of the signed-in viewer** — the app's service
principal never reads estate tables (its only estate touch is listing
Lakebase instances, metadata used to map their billing on the Apps tab), and
deploys never create or modify table grants. Each viewer therefore needs:

```sql
-- System tables the app reads (account admin grants these):
GRANT SELECT ON TABLE system.billing.usage                                        TO `<user-or-group>`;
GRANT SELECT ON TABLE system.billing.list_prices                                  TO `<user-or-group>`;
GRANT SELECT ON TABLE system.query.history                                        TO `<user-or-group>`;
GRANT SELECT ON TABLE system.access.audit                                         TO `<user-or-group>`;
GRANT SELECT ON TABLE system.access.table_lineage                                 TO `<user-or-group>`;
GRANT SELECT ON TABLE system.storage.predictive_optimization_operations_history   TO `<user-or-group>`;
GRANT SELECT ON TABLE system.compute.warehouses                                    TO `<user-or-group>`;
GRANT SELECT ON TABLE system.compute.clusters                                      TO `<user-or-group>`;
-- Genie-space job-name questions join this one (the app itself doesn't read it):
GRANT SELECT ON TABLE system.lakeflow.jobs                                         TO `<user-or-group>`;
-- OPTIONAL, Data Quality tab only: enriches monitors with quality statuses.
-- The tab works without it (monitors are discovered from their output tables).
GRANT SELECT ON TABLE system.data_quality_monitoring.table_results                TO `<user-or-group>`;
```

Plus: **CAN_USE** on the SQL warehouse and **CAN_RUN** on the Genie space
(the bundle grants Genie CAN_RUN to the `users` group automatically).
`system.information_schema` views need no grant — readable by every account
user. Viewers need **no grants on the app's own store**. On first sign-in
each viewer approves the app's OAuth consent (`sql`, `dashboards.genie`).

One workspace-level setting: the Apps tab's **on-behalf-of caller
attribution** reads `databrickssql.commandSubmit` audit events, which exist
only when **verbose audit logging** is enabled (workspace admin settings →
Advanced). Without it that card shows service-principal callers only — the
rest of the app is unaffected.

### The app-state store

* `lakebase` (default): nothing to prepare — the bundle creates the instance
  and provisions the app's Postgres role.
* `uc`: an account/metastore admin must pre-create a catalog the app's
  service principal can use:
  ```sql
  CREATE CATALOG <catalog> MANAGED LOCATION 's3://<ext-location>/<catalog>';  -- if no root storage
  GRANT USE CATALOG, CREATE SCHEMA ON CATALOG <catalog> TO `<app-sp-application-id>`;
  ```

---

## 2. Fill in the configuration

**Required: exactly ONE value — the SQL warehouse id.**

| Flow | Where to set it |
|---|---|
| Option 1 (workspace) | `databricks.yml` → `variables.warehouse_id.default` |
| Option 2 (deploy.sh) | `customise.yaml` → `warehouse_id` (blank = interactive picker) |

The app receives it automatically: the bundle feeds the variable into the
app's `sql-warehouse` resource binding and app.yaml reads it back with
`valueFrom: sql-warehouse` — the same mechanism that injects
`GENIE_SPACE_ID` from the `genie-space` binding. Never edit those two
`valueFrom` env entries.

**Shared workspaces:** `app_name` and `lakebase_instance` are
workspace-global names. If another deployment of this bundle already exists
in the workspace, reusing its instance name fails app creation with
`PERMISSION_DENIED — User needs MANAGE permission on the resource` (binding
a database instance requires managing it). Pick unique values for both —
in the workspace flow that is three edits: `variables.app_name.default` and
`variables.lakebase_instance.default` in databricks.yml, plus the matching
`FINOPS_LAKEBASE_INSTANCE` in app.yaml.

**Everything else is optional** — working defaults, override only what you
need. Option 1 edits the file listed; Option 2 sets the `customise.yaml` key
(deploy.sh writes it into the file for you):

| Setting (default) | Option 1 — edit | `customise.yaml` key |
|---|---|---|
| App name (`finops-command-center`) | `databricks.yml` → `variables.app_name.default` | — (`--app` flag) |
| Lakebase instance name (`finops-lakebase`) | `databricks.yml` → `variables.lakebase_instance.default` **and** `app.yaml` → `FINOPS_LAKEBASE_INSTANCE` (must match — the binding's `valueFrom` yields the Postgres host, not the name) | `lakebase_instance` (sets both) |
| Customer label (display + Genie space title) | `app.yaml` → `FINOPS_CUSTOMER_NAME`; title: `databricks.yml` → `variables.customer_name.default` | `customer_name` |
| App store (`lakebase`) | `app.yaml` → `FINOPS_APP_STORE` (+ `FINOPS_LAKEBASE_INSTANCE`, or `FINOPS_APP_CATALOG`/`FINOPS_APP_SCHEMA` for `uc`) | `app_store` etc. |
| Feature flags (all `true`) | `app.yaml` → `FINOPS_FEATURE_GENIE` / `_AI_NARRATION` / `_DQM` | `features.*` |
| Claude endpoint (AI reviews/narration) | `app.yaml` → `FINOPS_LLM_ENDPOINT` | `llm_endpoint` |
| AUD FX rate | `app.yaml` → `FINOPS_FX_AUD` | `fx_aud` |

---

## 3. Option 1 — deploy from the workspace (no local tooling)

1. Push this repo to your Git provider (GitHub / GitLab / Azure DevOps …).
2. In the target workspace: **Workspace → Create → Git folder**, clone the repo.
3. Edit the configuration values (section 2) in the workspace editor and
   commit them.
4. Open the folder — the **bundle panel** appears (it detects
   `databricks.yml`). Pick target **dev** and press **Deploy**. The dialog
   shows the CLI version the workspace runs; it must be ≥ v1.3.0 (current
   workspaces are far newer).
5. Start the app: press **▶ (run)** on the `finops` app resource in the
   bundle resources pane (equivalent of `bundle run finops`).
   Alternatively: **Compute → Apps → <app name> → Deploy**, source path
   `…/.bundle/finops-command-center/files`.
6. Verify (section 5).

Not possible from the workspace UI: deploying to a *different* workspace —
that needs the CLI or CI (add a production target with a `workspace.host` to
`databricks.yml` and deploy with `-t <target>`).

## 4. Option 2 — deploy with the local CLI

1. `databricks auth login --host https://<workspace-host>`
2. Edit `customise.yaml` (section 2). Leave `warehouse_id` blank to get an
   interactive picker.
3. Run:
   ```bash
   ./deploy.sh --profile <PROFILE> [--customise customise.<customer>.yaml] [--no-dqm] [--no-ai]
   ```
   which is exactly `databricks bundle deploy` + `databricks bundle run finops`
   after writing `customise.yaml` values into `app.yaml`/`config.yaml`.
4. Verify (section 5).

## 5. After deploying — verify

1. `/api/health` — must be `ok: true`: it checks, as the signed-in viewer,
   every grant-requiring system table plus the app-state store (with the
   app's own credentials).
2. `/api/config` — the `build` stamp matches your deploy; feature flags as
   configured.
3. Open the app: the SPA appears ~2 minutes after first start (it builds on
   the container; `/api/*` serves immediately).
4. Configuration page (gear, top right): set the **workspace scope**, and on
   the **Tags** tab exclude blanket tag keys (workspace-default tags) so
   coverage measures deliberate attribution.
5. Ask Genie: each viewer's first question triggers the OAuth consent.
