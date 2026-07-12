"""Access page: DIRECT Unity Catalog grants only (inherited rows are
echoes), each classified against the deterministic risk rules surfaced
verbatim on the Configuration page.
"""
from __future__ import annotations

from typing import Any
from data.runtime import _run


def _principal_type(name: str) -> str:
    n = str(name or "")
    if "@" in n:
        return "user"
    if len(n) == 36 and n.count("-") == 4:
        return "service_principal"
    return "group"


_BROAD_GROUPS = {"account users", "users", "all users", "public"}
_WIDE_PRIVILEGES = {"ALL PRIVILEGES", "ALL_PRIVILEGES", "MANAGE"}


def grants_live(warehouse_id: str) -> list[dict[str, Any]]:
    """DIRECT Unity Catalog grants only — the rows where policy is actually
    SET. Inherited rows in the privilege views merely echo one parent grant
    onto every child (the source of thousands-of-rows explosions), so they
    are excluded at the source; a catalog-level grant IS access to everything
    inside it, and the UI presents it that way. Each grant carries its
    concern classification (same rules as RISK_DEFINITIONS on the
    Configuration page). Excluded as noise: samples + __databricks_internal*
    (vendor plumbing) and every catalog's information_schema (system-provided
    metadata, readable by design — grants on it are not a policy signal)."""
    raw = _run(warehouse_id, """
        SELECT grantee, catalog_name AS c, NULL AS s, NULL AS t,
               privilege_type, 'catalog' AS lvl
        FROM system.information_schema.catalog_privileges
        WHERE inherited_from = 'NONE'
          AND catalog_name <> 'samples' AND catalog_name NOT LIKE '\\_\\_databricks\\_internal%'
        UNION ALL
        SELECT grantee, catalog_name, schema_name, NULL, privilege_type, 'schema'
        FROM system.information_schema.schema_privileges
        WHERE inherited_from = 'NONE'
          AND catalog_name <> 'samples' AND catalog_name NOT LIKE '\\_\\_databricks\\_internal%'
          AND schema_name <> 'information_schema'
        UNION ALL
        SELECT grantee, table_catalog, table_schema, table_name, privilege_type, 'table'
        FROM system.information_schema.table_privileges
        WHERE inherited_from = 'NONE'
          AND table_catalog <> 'samples' AND table_catalog NOT LIKE '\\_\\_databricks\\_internal%'
          AND table_schema <> 'information_schema'
        ORDER BY lvl, c, s, t, grantee, privilege_type
        LIMIT 4000""", "system.information_schema privileges")
    grants = []
    for i, r in enumerate(raw):
        cat, sch, tab = r.get("c"), r.get("s"), r.get("t")
        fqn = ".".join(p for p in (cat, sch, tab) if p)
        principal = str(r.get("grantee") or "")
        privilege = str(r.get("privilege_type") or "")
        broad = principal.lower() in _BROAD_GROUPS
        wide = privilege in _WIDE_PRIVILEGES
        concern = "critical" if (broad and wide) else ("warning" if (broad or wide) else None)
        reason = None
        if concern:
            reason = ("Granted to an all-users group AND carries full control — every account "
                      "identity holds it" if (broad and wide)
                      else "Granted to an all-users group — every account identity inherits it" if broad
                      else "ALL PRIVILEGES / MANAGE — full control incl. dropping the object and re-granting")
        grants.append({
            "id": i, "principal": principal,
            "principal_type": _principal_type(principal),
            "privilege": privilege,
            "securable": fqn, "level": str(r.get("lvl")),
            "catalog": cat, "schema": sch, "table": tab,
            "concern": concern, "concern_reason": reason,
        })
    return grants


# The exact rules behind the Access page's Risk flags panel. Surfaced verbatim
# on the Configuration page — keep this in lockstep with risks_from below.
RISK_DEFINITIONS = {
    "flags": [
        {"flag": "Broad grant", "severity": "warning",
         "definition": "A privilege granted directly to an all-users group ('account users', 'users', 'all users' or PUBLIC). Every identity in the account inherits it."},
        {"flag": "Wide privilege", "severity": "warning",
         "definition": "ALL PRIVILEGES or MANAGE granted directly on a catalog, schema or table — full control, including dropping the object and re-granting access."},
        {"flag": "Broad grant + wide privilege", "severity": "critical",
         "definition": "Both conditions on the same grant: every user in the account holds full control of the securable."},
    ],
    "notes": [
        "Source: system.information_schema table/schema/catalog privileges (Unity Catalog grants).",
        "Direct grants only — rows inherited from a parent securable are excluded, so one catalog-level grant is not re-counted on every child schema and table.",
        "The samples and __databricks_internal* catalogs are excluded from grants and flags, as is every catalog's information_schema (system-provided metadata, readable by design).",
        "Principal type is inferred from the grantee name: contains '@' = user; 36-character UUID = service principal; otherwise group.",
        "Deterministic rules, no model involved; capped at 200 flags; no dollar impact is estimated for access risks.",
    ],
}


def risks_from(grants: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The concerning grants (already classified row-by-row in grants_live,
    per RISK_DEFINITIONS)."""
    risks = []
    for g in grants:
        if not g.get("concern"):
            continue
        risks.append({
            "id": len(risks) + 1, "principal": g["principal"],
            "severity": g["concern"],
            "detail": f"{g['privilege']} on {g['level']} {g['securable']} — {g['concern_reason']}",
            "recommended_action": "Scope this grant to a purpose-built group with least privilege.",
        })
    return risks[:200]
