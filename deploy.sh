#!/usr/bin/env bash
# FinOps Command Center — one-command deploy to a Databricks App.
# Usage: ./deploy.sh [--profile PROFILE] [--app APP_NAME] [--target TARGET]
#                    [--customise FILE] [--no-ai] [--no-dqm]
#
# Reads live system tables through the configured warehouse; grants are
# required to run the app.
#
# ── Per-customer config ─────────────────────────────────────────────────────
# Onboard a customer by editing `customise.yaml` (customer_name, warehouse_id,
# app_store, fx_aud, llm_endpoint, feature flags) — NO code edits. deploy.sh
# reads that file and writes the matching env into app.yaml so the deployed
# app picks it up. Env always wins over config.yaml (see data/config.py).
#
# The Genie space is a bundle resource (resources/finops_genie_space.json);
# the app reads its id at runtime from the `genie-space` resource binding.
#
# Prefer zero local tooling? The same bundle deploys entirely from the
# workspace UI (Git folder + bundle panel) — see docs/DEPLOYMENT.md
# § "Deploy from the workspace". In that flow edit app.yaml directly;
# this script's customise.yaml templating is a local convenience only.
#
# ── Feature-flag convenience — four deploy variants ─────────────────────────
#   (default)        take flags from customise.yaml (AI+DQM if unset)
#   --no-ai          force genie=false ai_narration=false      (DQM-only)
#   --no-dqm         force dqm=false                           (AI-only)
#   --no-ai --no-dqm force both off                            (neither)
#
# The CLI switches OVERRIDE customise.yaml for this one run — customise.yaml is
# the declarative alternative for a permanent, self-documenting choice.
#
# --no-ai turns OFF the Ask Genie banner AND LLM narration; --no-dqm turns OFF
# the Data Quality tab. Both write the FINOPS_FEATURE_* env into app.yaml so the
# deployed app renders + serves them inert. The deterministic recommender,
# cost-attribution and Genie-cost view are ALWAYS on.
set -euo pipefail

PROFILE="${DATABRICKS_PROFILE:-DEFAULT}"
APP_NAME="${FINOPS_APP_NAME:-finops-command-center}"
TARGET=""
CUSTOMISE_FILE="customise.yaml"
OVERRIDE_NO_AI="false"
OVERRIDE_NO_DQM="false"

while [[ $# -gt 0 ]]; do
  case $1 in
    --profile)   PROFILE="$2"; shift 2 ;;
    --app)       APP_NAME="$2"; shift 2 ;;
    --target)    TARGET="$2"; shift 2 ;;
    --customise) CUSTOMISE_FILE="$2"; shift 2 ;;
    --no-ai)     OVERRIDE_NO_AI="true"; shift ;;
    --no-dqm)    OVERRIDE_NO_DQM="true"; shift ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done
TARGET_FLAG="${TARGET:+--target $TARGET}"

# ── Read customise.yaml → shell vars (declarative per-customer config) ──────
# Falls back to sensible demo defaults when the file or a key is absent. Emits
# CFG_* lines that we eval; values are shell-quoted so spaces are safe.
eval "$(python3 - "$CUSTOMISE_FILE" <<'PY'
import sys, pathlib, shlex
defaults = {
    "customer_name": "Energy for All",
    "warehouse_id": "",
    "app_store": "lakebase",
    "lakebase_instance": "finops-lakebase",
    "app_catalog": "main",
    "app_schema": "finops_cache",
    "fx_aud": "1.52",
    "llm_endpoint": "databricks-claude-sonnet-4-6",
}
cfg = {}
p = pathlib.Path(sys.argv[1])
if p.exists():
    try:
        import yaml
        cfg = yaml.safe_load(p.read_text()) or {}
    except Exception as e:
        sys.stderr.write(f"warn: could not parse {p} ({e}); using defaults\n")
        cfg = {}

def g(key, d):
    v = cfg.get(key, d)
    return d if v is None else v

feats = cfg.get("features") or {}
out = {
    "customer_name": g("customer_name", defaults["customer_name"]),
    "warehouse_id":  g("warehouse_id", defaults["warehouse_id"]),
    "app_store":     g("app_store", defaults["app_store"]),
    "lakebase_instance": g("lakebase_instance", defaults["lakebase_instance"]),
    "app_catalog":   g("app_catalog", defaults["app_catalog"]),
    "app_schema":    g("app_schema", defaults["app_schema"]),
    "fx_aud":        g("fx_aud", defaults["fx_aud"]),
    "llm_endpoint":  g("llm_endpoint", defaults["llm_endpoint"]),
    "feat_genie":    str(feats.get("genie", True)).lower(),
    "feat_ai_narration": str(feats.get("ai_narration", False)).lower(),
    "feat_dqm":      str(feats.get("dqm", True)).lower(),
}
for k, v in out.items():
    print(f"CFG_{k.upper()}={shlex.quote(str(v))}")
PY
)"

# ── Apply CLI overrides on top of the declarative flags ─────────────────────
FEAT_GENIE="$CFG_FEAT_GENIE"
FEAT_AI_NARRATION="$CFG_FEAT_AI_NARRATION"
FEAT_DQM="$CFG_FEAT_DQM"
if [[ "$OVERRIDE_NO_AI" == "true" ]]; then
  FEAT_GENIE="false"; FEAT_AI_NARRATION="false"
fi
if [[ "$OVERRIDE_NO_DQM" == "true" ]]; then
  FEAT_DQM="false"
fi

# No warehouse in the config? List the workspace's SQL warehouses and ask.
if [ -z "$CFG_WAREHOUSE_ID" ]; then
  echo ""
  echo "No warehouse_id set in $CUSTOMISE_FILE — SQL warehouses in this workspace:"
  WH_JSON=$(databricks warehouses list --profile "$PROFILE" --output json 2>/dev/null || echo "[]")
  echo "$WH_JSON" | python3 -c '
import sys, json
ws = json.load(sys.stdin)
if not ws:
    sys.exit("  (none found — create a SQL warehouse first)")
for i, w in enumerate(ws, 1):
    kind = "serverless" if w.get("enable_serverless_compute") else w.get("cluster_size", "")
    extra = ", " + kind if kind else ""
    print("  [%d] %s  %s  (%s%s)" % (i, w.get("id"), w.get("name", ""), w.get("state", "?"), extra))
'
  read -r -p "Pick a number (or paste a warehouse ID): " WH_CHOICE
  CFG_WAREHOUSE_ID=$(echo "$WH_JSON" | python3 -c '
import sys, json
ws = json.load(sys.stdin)
c = sys.argv[1].strip()
if c.isdigit() and 1 <= int(c) <= len(ws):
    print(ws[int(c) - 1]["id"])
elif any(w.get("id") == c for w in ws):
    print(c)
' "$WH_CHOICE")
  if [ -z "$CFG_WAREHOUSE_ID" ]; then
    echo "error: invalid selection" >&2
    exit 1
  fi
  echo "  using warehouse $CFG_WAREHOUSE_ID"
fi

# Bundle variables resolved from the config (and the pick above). The
# warehouse id reaches the app THROUGH the bundle (sql-warehouse resource
# binding → valueFrom in app.yaml) — it is never written into app.yaml here.
# The Genie space itself is a bundle resource
# (resources/finops_genie_space.json) — no separate step.
VAR_FLAGS=(--var "warehouse_id=$CFG_WAREHOUSE_ID"
           --var "lakebase_instance=$CFG_LAKEBASE_INSTANCE"
           --var "customer_name=$CFG_CUSTOMER_NAME")

STORE_LABEL="$CFG_APP_STORE"
if [ "$CFG_APP_STORE" = "uc" ]; then
  STORE_LABEL="uc ($CFG_APP_CATALOG.$CFG_APP_SCHEMA)"
else
  STORE_LABEL="lakebase ($CFG_LAKEBASE_INSTANCE)"
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  FinOps Command Center — Deploy"
echo "  Profile : $PROFILE"
echo "  App     : $APP_NAME"
echo "  Target  : ${TARGET:-dev (default)}"
echo "  Config  : $CUSTOMISE_FILE  (customer=$CFG_CUSTOMER_NAME)"
echo "  Live    : warehouse=$CFG_WAREHOUSE_ID  app store=$STORE_LABEL  fx_aud=$CFG_FX_AUD"
echo "  Features: genie=$FEAT_GENIE  ai_narration=$FEAT_AI_NARRATION  dqm=$FEAT_DQM"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Write a resolved value into app.yaml env. Matches quoted OR unquoted values,
# and appends the entry under `env:` if it is missing.
_set_env() {  # $1 = env name, $2 = value
  python3 - "$1" "$2" <<'PY'
import re, sys, pathlib
name, value = sys.argv[1], sys.argv[2]
p = pathlib.Path("app.yaml"); text = p.read_text()
# Match "- name: NAME\n    value: <anything>" (quoted or bare) and replace value.
pat = re.compile(r'(-\s*name:\s*' + re.escape(name) + r'\s*\n\s*value:\s*).*')
new, n = pat.subn(lambda m: m.group(1) + f'"{value}"', text)
if n == 0:
    if not text.endswith("\n"):
        text += "\n"
    new = text + f'  - name: {name}\n    value: "{value}"\n'
p.write_text(new)
PY
}

# Scalar + string config → app.yaml env (env wins over config.yaml).
# DATABRICKS_WAREHOUSE_ID is deliberately NOT written: it is valueFrom the
# sql-warehouse resource binding, fed by --var warehouse_id above.
_set_env FINOPS_CUSTOMER_NAME     "$CFG_CUSTOMER_NAME"
_set_env FINOPS_APP_STORE         "$CFG_APP_STORE"
_set_env FINOPS_LAKEBASE_INSTANCE "$CFG_LAKEBASE_INSTANCE"
_set_env FINOPS_APP_CATALOG       "$CFG_APP_CATALOG"
_set_env FINOPS_APP_SCHEMA        "$CFG_APP_SCHEMA"
_set_env FINOPS_FX_AUD            "$CFG_FX_AUD"
_set_env FINOPS_LLM_ENDPOINT      "$CFG_LLM_ENDPOINT"
# Feature flags (customise.yaml + any --no-ai / --no-dqm override).
_set_env FINOPS_FEATURE_GENIE        "$FEAT_GENIE"
_set_env FINOPS_FEATURE_AI_NARRATION "$FEAT_AI_NARRATION"
_set_env FINOPS_FEATURE_DQM          "$FEAT_DQM"
# The frontend is NEVER built locally: frontend/src ships with the bundle and
# start.sh builds it on the Databricks Apps container (Node 22 + npm live there).

echo "[1/2] Deploying bundle (App resource + source sync)…"
databricks bundle deploy --profile "$PROFILE" ${TARGET_FLAG} "${VAR_FLAGS[@]}"

echo "[2/2] Deploying + starting app (bundle run)…"
databricks bundle run finops --profile "$PROFILE" ${TARGET_FLAG} "${VAR_FLAGS[@]}"

URL=$(databricks apps get "$APP_NAME" --profile "$PROFILE" 2>/dev/null \
  | grep -o 'https://[^"]*databricksapps\.com[^"]*' | head -1 || echo "")
echo ""
echo "  ✓ Deployed. Open: ${URL:-run: databricks apps get $APP_NAME --profile $PROFILE}"
