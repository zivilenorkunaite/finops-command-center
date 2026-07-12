"""Deploy-time configuration + feature-flag resolution.

Single source of truth for the flag contract consumed by ``app.py`` and every
``/api/*`` endpoint. Precedence (highest first):

  1. Environment variable  (FINOPS_FEATURE_*, GENIE_SPACE_ID, …)
  2. ``config.yaml``        (optional; sits next to app.py)
  3. Built-in default

The three feature flags gate optional surfaces:

  * ``features.genie``        — the Ask Genie banner + ``/api/genie/ask`` SSE.
  * ``features.ai_narration`` — optional LLM rationale on recommendations.
  * ``features.dqm``          — the Data Quality Monitoring tab + ``/api/dqm``.

A flag being ``false`` must make the surface *inert server-side* too — the
guarded endpoints raise 404 and never issue a Genie/model call. The
deterministic recommender, cost-attribution and Genie-cost attribution are
ALWAYS on (they call no model) and are not gated by any flag.
"""
from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path
from typing import Any

_CONFIG_PATH = Path(__file__).resolve().parent.parent / "config.yaml"

# Built-in defaults (lowest precedence). All features default ON — disable
# per deployment via env/config if needed.
_DEFAULTS: dict[str, Any] = {
    "features": {"genie": True, "ai_narration": True, "dqm": True},
    # Where the app keeps its own state (workspace scope + query-advisor
    # cache): "lakebase" (managed Postgres, created by the bundle — default)
    # or "uc" (Delta tables in app_catalog.app_schema).
    "app_store": "lakebase",
    "lakebase_instance": "finops-lakebase",
    "lakebase_database": "databricks_postgres",
    # The app's Unity Catalog home — used only when app_store is "uc".
    "app_catalog": "main",
    "app_schema": "finops_cache",
    "genie_space_id": "",
    "warehouse_id": "",
    "fx_rate": 1.52,
    "llm_endpoint": "databricks-claude-sonnet-4-6",
}

# env var name -> (config key path, coercion). Env always wins over config.yaml.
_ENV_BOOL = {
    "FINOPS_FEATURE_GENIE": ("features", "genie"),
    "FINOPS_FEATURE_AI_NARRATION": ("features", "ai_narration"),
    "FINOPS_FEATURE_DQM": ("features", "dqm"),
}


def _as_bool(val: Any, fallback: bool) -> bool:
    if isinstance(val, bool):
        return val
    if val is None:
        return fallback
    return str(val).strip().lower() in ("1", "true", "yes", "on")


@lru_cache(maxsize=1)
def _file_config() -> dict[str, Any]:
    """Load config.yaml if present. Never raises — a missing/broken file just
    means the env + defaults take over."""
    if not _CONFIG_PATH.exists():
        return {}
    try:
        import yaml  # type: ignore

        loaded = yaml.safe_load(_CONFIG_PATH.read_text()) or {}
        return loaded if isinstance(loaded, dict) else {}
    except Exception:
        return {}


def _resolve_flag(name: str, key: str) -> bool:
    """Resolve one feature flag: env var > config.yaml > default."""
    default = bool(_DEFAULTS["features"][key])
    file_features = _file_config().get("features") or {}
    file_val = file_features.get(key, default)
    env_val = os.environ.get(name)
    if env_val is not None:
        return _as_bool(env_val, _as_bool(file_val, default))
    return _as_bool(file_val, default)


@lru_cache(maxsize=1)
def get_features() -> dict[str, bool]:
    """The resolved ``{genie, ai_narration, dqm}`` flag contract."""
    return {
        "genie": _resolve_flag("FINOPS_FEATURE_GENIE", "genie"),
        "ai_narration": _resolve_flag("FINOPS_FEATURE_AI_NARRATION", "ai_narration"),
        "dqm": _resolve_flag("FINOPS_FEATURE_DQM", "dqm"),
    }


def _resolve_scalar(env_names: list[str], key: str) -> Any:
    """Resolve a scalar config value: env var > config.yaml > default."""
    for env in env_names:
        val = os.environ.get(env)
        if val not in (None, ""):
            return val
    file_val = _file_config().get(key)
    if file_val not in (None, ""):
        return file_val
    return _DEFAULTS[key]


@lru_cache(maxsize=1)
def get_settings() -> dict[str, Any]:
    """Resolved non-flag settings surfaced to the app + UI. fx_rate is a
    deploy-time value (customise.yaml) — no runtime override exists."""
    fx_raw = _resolve_scalar(["FINOPS_FX_AUD", "FINOPS_FX_RATE"], "fx_rate")
    try:
        fx = float(fx_raw)
    except (TypeError, ValueError):
        fx = float(_DEFAULTS["fx_rate"])
    return {
        "app_store": str(_resolve_scalar(["FINOPS_APP_STORE"], "app_store")).lower(),
        "lakebase_instance": _resolve_scalar(["FINOPS_LAKEBASE_INSTANCE"], "lakebase_instance"),
        "lakebase_database": _resolve_scalar(["FINOPS_LAKEBASE_DATABASE"], "lakebase_database"),
        "app_catalog": _resolve_scalar(["FINOPS_APP_CATALOG"], "app_catalog"),
        "app_schema": _resolve_scalar(["FINOPS_APP_SCHEMA"], "app_schema"),
        "genie_space_id": _resolve_scalar(["GENIE_SPACE_ID", "FINOPS_GENIE_SPACE_ID"], "genie_space_id"),
        "warehouse_id": _resolve_scalar(["DATABRICKS_WAREHOUSE_ID", "FINOPS_WAREHOUSE_ID"], "warehouse_id"),
        "fx_rate": fx,
        "llm_endpoint": _resolve_scalar(["FINOPS_LLM_ENDPOINT"], "llm_endpoint"),
    }


def reset_cache() -> None:
    """Clear memoised config — used by tests that mutate the environment."""
    _file_config.cache_clear()
    get_features.cache_clear()
    get_settings.cache_clear()
