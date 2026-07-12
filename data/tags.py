"""Tags tab: coverage, key catalog and per-tag search across billing usage
tags and the five Unity Catalog *_tags views. Coverage honours the
operator's tag exclusions (blanket keys don't count), and a usage row's
cost counts FULLY under each of its keys — tags don't split a row.
"""
from __future__ import annotations

from typing import Any
from data.runtime import _f, _run, _sql_str, _ttl_cache
from data.store import _untagged_pred, _ws_scope_sql, tag_exclusions


# ---------------------------------------------------------------------------
# Tags — coverage, key catalog and search across billing usage tags (cluster /
# warehouse / job custom tags, budget-policy tags) and Unity Catalog securable
# tags from the five *_tags views.
# ---------------------------------------------------------------------------
_UC_TAG_VIEWS = (
    ("catalog", "system.information_schema.catalog_tags", "catalog_name"),
    ("schema", "system.information_schema.schema_tags", "catalog_name || '.' || schema_name"),
    ("table", "system.information_schema.table_tags",
     "catalog_name || '.' || schema_name || '.' || table_name"),
    ("column", "system.information_schema.column_tags",
     "catalog_name || '.' || schema_name || '.' || table_name || '.' || column_name"),
    ("volume", "system.information_schema.volume_tags",
     "catalog_name || '.' || schema_name || '.' || volume_name"),
)


def _uc_tags_union() -> str:
    return " UNION ALL ".join(
        f"SELECT '{lvl}' AS level, {fqn} AS securable, tag_name, COALESCE(tag_value, '') AS tag_value FROM {view}"
        for lvl, view, fqn in _UC_TAG_VIEWS)


def tags_live(warehouse_id: str) -> dict[str, Any]:
    """Tag coverage + catalog: month-to-date billing spend tagged vs untagged
    by product, per-key spend across all custom_tags, and Unity Catalog
    securable tag assignments."""
    price_join = """
        LEFT JOIN system.billing.list_prices lp ON u.cloud = lp.cloud AND u.sku_name = lp.sku_name
         AND u.usage_start_time >= lp.price_start_time
         AND (lp.price_end_time IS NULL OR u.usage_start_time < lp.price_end_time)"""
    scope = _ws_scope_sql(warehouse_id)

    cov = _run(warehouse_id, f"""
        SELECT u.billing_origin_product AS product,
               SUM(u.usage_quantity * lp.pricing.effective_list.default) AS usd,
               SUM(CASE WHEN NOT {_untagged_pred(warehouse_id, 'u.custom_tags')}
                        THEN u.usage_quantity * lp.pricing.effective_list.default ELSE 0 END) AS tagged_usd
        FROM system.billing.usage u{price_join}
        WHERE u.usage_date >= date_trunc('MONTH', current_date()){scope}
        GROUP BY 1 ORDER BY usd DESC""", "system.billing.usage (tag coverage)")
    by_product = []
    for r in cov:
        usd, tagged = _f(r.get("usd")), _f(r.get("tagged_usd"))
        by_product.append({
            "product": str(r.get("product") or ""),
            "usd": round(usd, 2), "tagged_usd": round(tagged, 2),
            "tagged_pct": round(tagged / usd, 3) if usd else 0.0,
        })
    total = sum(p["usd"] for p in by_product)
    tagged_total = sum(p["tagged_usd"] for p in by_product)

    # Per-key spend. A usage row carrying 3 tags counts fully under each of
    # its keys — the catalog answers "how much spend carries this tag", not a
    # partition of total spend. approx distinct keeps wild-cardinality keys
    # (run ids…) from exploding the aggregate.
    key_rows = _run(warehouse_id, f"""
        SELECT kv.key AS tag_key,
               approx_count_distinct(kv.value) AS num_values,
               SUM(t.usd) AS usd
        FROM (SELECT u.custom_tags,
                     u.usage_quantity * lp.pricing.effective_list.default AS usd
              FROM system.billing.usage u{price_join}
              WHERE u.usage_date >= date_trunc('MONTH', current_date()){scope}
                AND u.custom_tags IS NOT NULL
                AND cardinality(map_keys(u.custom_tags)) > 0) t
        LATERAL VIEW explode(t.custom_tags) kv AS key, value
        GROUP BY 1 ORDER BY usd DESC LIMIT 400""", "system.billing.usage (tag keys)")
    # True distinct-key count — len(key_rows) would saturate at the LIMIT.
    key_count_rows = _run(warehouse_id, f"""
        SELECT COUNT(DISTINCT kv.key) AS n
        FROM (SELECT u.custom_tags
              FROM system.billing.usage u
              WHERE u.usage_date >= date_trunc('MONTH', current_date()){scope}
                AND u.custom_tags IS NOT NULL
                AND cardinality(map_keys(u.custom_tags)) > 0) t
        LATERAL VIEW explode(t.custom_tags) kv AS key, value
        """, "system.billing.usage (tag key count)")

    uc_rows = _run(warehouse_id, f"""
        SELECT level, tag_name, COUNT(*) AS n
        FROM ({_uc_tags_union()})
        GROUP BY 1, 2""", "information_schema *_tags")
    uc_counts: dict[str, int] = {}
    securables_by_key: dict[str, int] = {}
    uc_keys = set()
    for r in uc_rows:
        lvl, key, n = str(r.get("level")), str(r.get("tag_name") or ""), int(_f(r.get("n")))
        uc_counts[lvl] = uc_counts.get(lvl, 0) + n
        securables_by_key[key] = securables_by_key.get(key, 0) + n
        uc_keys.add(key)

    excluded = set(tag_exclusions(warehouse_id))
    keys = []
    seen = set()
    for r in key_rows:
        key = str(r.get("tag_key") or "")
        seen.add(key)
        usd = round(_f(r.get("usd")), 2)
        keys.append({
            "key": key,
            "usd": usd,
            # Share of TOTAL spend whose rows carry this key — ≥50% usually
            # means a workspace-default or platform-injected blanket tag.
            "pct_of_spend": round(usd / total, 3) if total else 0.0,
            "num_values": int(_f(r.get("num_values"))),
            "securables": securables_by_key.get(key, 0),
            "excluded": key in excluded,
        })
    # Keys that exist only on securables still belong in the catalog — zero
    # billed spend is a finding, not an omission.
    for key in sorted(uc_keys - seen):
        keys.append({"key": key, "usd": 0.0, "pct_of_spend": 0.0, "num_values": 0,
                     "securables": securables_by_key.get(key, 0),
                     "excluded": key in excluded})
    for key in sorted(excluded - seen - uc_keys):
        keys.append({"key": key, "usd": 0.0, "pct_of_spend": 0.0, "num_values": 0,
                     "securables": 0, "excluded": True})

    return {
        "total_usd": round(total, 2),
        "tagged_usd": round(tagged_total, 2),
        "tagged_pct": round(tagged_total / total, 3) if total else 0.0,
        "by_product": by_product,
        "keys": keys,
        "excluded_keys": sorted(excluded),
        "uc_counts": uc_counts,
        "uc_total": sum(uc_counts.values()),
        "distinct_keys_billing": int(_f((key_count_rows[0] if key_count_rows else {}).get("n"))),
        "distinct_keys_uc": len(uc_keys),
    }


@_ttl_cache(600)
def tag_search_live(warehouse_id: str, key: str, value: str | None = None) -> dict[str, Any]:
    """Everything carrying ONE tag: billed resources (with month-to-date cost
    at list price) + Unity Catalog securables. Cost is the FULL cost of usage
    rows carrying the tag — tags don't split a row."""
    k = _sql_str(str(key)[:255])
    vf = f" AND t.custom_tags['{k}'] = '{_sql_str(str(value)[:255])}'" if value else ""
    price_join = """
        LEFT JOIN system.billing.list_prices lp ON u.cloud = lp.cloud AND u.sku_name = lp.sku_name
         AND u.usage_start_time >= lp.price_start_time
         AND (lp.price_end_time IS NULL OR u.usage_start_time < lp.price_end_time)"""
    scope = _ws_scope_sql(warehouse_id)
    base = f"""
        FROM (SELECT u.custom_tags, u.usage_metadata, u.billing_origin_product,
                     u.workspace_id,
                     u.usage_quantity * lp.pricing.effective_list.default AS usd
              FROM system.billing.usage u{price_join}
              WHERE u.usage_date >= date_trunc('MONTH', current_date()){scope}
                AND u.custom_tags['{k}'] IS NOT NULL) t
        WHERE 1=1{vf}"""

    resources = _run(warehouse_id, f"""
        SELECT CASE WHEN t.usage_metadata.warehouse_id IS NOT NULL THEN 'SQL warehouse'
                    WHEN t.usage_metadata.job_id IS NOT NULL THEN 'job'
                    WHEN t.usage_metadata.dlt_pipeline_id IS NOT NULL THEN 'pipeline'
                    WHEN t.usage_metadata.endpoint_name IS NOT NULL THEN 'serving endpoint'
                    WHEN t.usage_metadata.app_name IS NOT NULL THEN 'app'
                    WHEN t.usage_metadata.cluster_id IS NOT NULL THEN 'cluster'
                    ELSE lower(t.billing_origin_product) END AS asset_type,
               COALESCE(t.usage_metadata.warehouse_id,
                        CAST(t.usage_metadata.job_id AS STRING),
                        t.usage_metadata.dlt_pipeline_id,
                        t.usage_metadata.endpoint_name,
                        t.usage_metadata.app_name,
                        t.usage_metadata.cluster_id,
                        t.billing_origin_product) AS asset,
               CAST(t.workspace_id AS STRING) AS ws,
               MIN(t.custom_tags['{k}']) AS tag_value,
               SUM(t.usd) AS usd
        {base}
        GROUP BY 1, 2, 3 ORDER BY usd DESC LIMIT 200""", "system.billing.usage (tag search)")

    by_value = _run(warehouse_id, f"""
        SELECT COALESCE(t.custom_tags['{k}'], '') AS value, SUM(t.usd) AS usd
        {base}
        GROUP BY 1 ORDER BY usd DESC LIMIT 30""", "system.billing.usage (tag values)")

    totals = _run(warehouse_id, f"SELECT SUM(t.usd) AS usd {base}",
                  "system.billing.usage (tag total)")

    vfilter = f" AND COALESCE(tag_value, '') = '{_sql_str(str(value)[:255])}'" if value else ""
    securables = _run(warehouse_id, f"""
        SELECT level, securable, tag_value
        FROM ({_uc_tags_union()})
        WHERE tag_name = '{k}'{vfilter}
        ORDER BY level, securable LIMIT 300""", "information_schema *_tags (search)")

    return {
        "key": str(key), "value": value,
        "total_usd": round(_f((totals[0] if totals else {}).get("usd")), 2),
        "resources": [{
            "asset_type": str(r.get("asset_type") or ""),
            "asset": str(r.get("asset") or ""),
            "workspace": str(r.get("ws") or ""),
            "tag_value": str(r.get("tag_value") or ""),
            "usd": round(_f(r.get("usd")), 2),
        } for r in resources],
        "by_value": [{"value": str(r.get("value") or ""), "usd": round(_f(r.get("usd")), 2)}
                     for r in by_value],
        "securables": [{
            "level": str(r.get("level") or ""),
            "securable": str(r.get("securable") or ""),
            "tag_value": str(r.get("tag_value") or ""),
        } for r in securables],
    }
