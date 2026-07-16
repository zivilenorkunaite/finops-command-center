"""Preflight: cheap read checks, AS THE VIEWER, of every grant-requiring
system table the app uses — plus the app-state store with the app's own
credentials. The DQM system table is probed as OPTIONAL (the Data Quality
tab works without it), so a missing grant never flips overall health.
"""
from __future__ import annotations

from typing import Any
from data.runtime import LiveError, _run
from data.store import _app_schema, _pg_ensure, _pg_exec, _schema_fqn, _store_is_lakebase


# ---------------------------------------------------------------------------
# Preflight — a cheap health check so misconfig surfaces on boot.
# ---------------------------------------------------------------------------
# The grant-requiring system tables the app reads (as the viewer). DQM is
# feature-gated, so its table only degrades health when the tab is on.
# information_schema views are deliberately NOT probed: they are
# system-provided metadata readable by every account user by default, so
# evaluating access to them is noise (operator decision).
_PREFLIGHT_TABLES = [
    "system.billing.usage",
    "system.billing.list_prices",
    "system.query.history",
    "system.access.audit",
    "system.access.table_lineage",
    "system.storage.predictive_optimization_operations_history",
    # Governance compute-hygiene tiles read these as the viewer:
    "system.compute.warehouses",
    "system.compute.clusters",
]
_PREFLIGHT_DQM_TABLE = "system.data_quality_monitoring.table_results"


def preflight(warehouse_id: str) -> dict[str, Any]:
    """Check, as the signed-in viewer, read access to every system table the
    app uses — plus the app schema via the app's own credentials. Returns a
    structured report (never raises) so /api/health can render it."""
    from data.config import get_features

    checks: list[dict[str, Any]] = []
    for name in _PREFLIGHT_TABLES:
        try:
            _run(warehouse_id, f"SELECT 1 FROM {name} LIMIT 1", name)
            checks.append({"name": name, "ok": True, "error": None})
        except LiveError as e:
            checks.append({"name": name, "ok": False, "error": e.detail})
    # The DQM system table is OPTIONAL: the Data Quality tab discovers
    # monitors from their output tables and only enriches from table_results
    # when granted — a missing grant must not flip overall health.
    if get_features().get("dqm"):
        name = f"{_PREFLIGHT_DQM_TABLE} (optional — enriches Data Quality)"
        try:
            _run(warehouse_id, f"SELECT 1 FROM {_PREFLIGHT_DQM_TABLE} LIMIT 1", _PREFLIGHT_DQM_TABLE)
            checks.append({"name": name, "ok": True, "error": None, "optional": True})
        except LiveError as e:
            checks.append({"name": name, "ok": False, "error": e.detail, "optional": True})
    # App-owned state is read/written with the APP's credentials, not the
    # viewer's — probe that identity separately.
    if _store_is_lakebase():
        from data.config import get_settings

        import os
        store_via = os.environ.get("PGHOST") or get_settings().get("lakebase_instance")
        store_name = f"lakebase {store_via} (app credentials)"
        try:
            _pg_ensure()
            _pg_exec("SELECT 1", fetch=True)
            checks.append({"name": store_name, "ok": True, "error": None})
        except LiveError as e:
            checks.append({"name": store_name, "ok": False, "error": e.detail})
    else:
        try:
            # Parity with the lakebase probe (_pg_ensure + SELECT 1): actually
            # ensure the store's DDL, not just list it — a metastore that can't
            # create managed tables (e.g. no root storage credential) must turn
            # this check red instead of reporting healthy while every write fails.
            from data.cache import _uc_cache_ensure

            _uc_cache_ensure(warehouse_id)
            _run(warehouse_id, f"SHOW TABLES IN {_schema_fqn()}", "app schema", as_app=True)
            checks.append({"name": f"{'.'.join(_app_schema())} (app credentials)", "ok": True, "error": None})
        except LiveError as e:
            checks.append({"name": "app schema (app credentials)", "ok": False, "error": e.detail})
    return {"ok": all(c["ok"] for c in checks if not c.get("optional")),
            "warehouse_id": warehouse_id, "checks": checks}
