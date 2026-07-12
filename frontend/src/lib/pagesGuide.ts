// Single source of truth for "what every tab shows and which tables feed
// it" — rendered on the Configuration page AND in every page's missing-access
// error card. Keep in lockstep with the loaders in data/live.py.
import type { PageId } from "../types";

export interface TabGuide {
  id: PageId;
  label: string;
  description: string;
  tables: string[];
  note?: string;
}

export const TAB_GUIDE: TabGuide[] = [
  {
    id: "overview",
    label: "Overview",
    description:
      "Estate spend at a glance — month-to-date total, weekly trend, optimisation-complexity mix, and the worst open best-practice check per workspace as top opportunities.",
    tables: ["system.billing.usage", "system.billing.list_prices"],
  },
  {
    id: "access",
    label: "Access",
    description:
      "Direct Unity Catalog grants aggregated by object and by principal, with concerning grants (broad groups, wide privileges) flagged by the deterministic rules documented under Access rules.",
    tables: [
      "system.information_schema.catalog_privileges",
      "system.information_schema.schema_privileges",
      "system.information_schema.table_privileges",
    ],
  },
  {
    id: "workspaces",
    label: "Workspaces",
    description:
      "Per-workspace spend and DBUs with the best-practice checks (tag coverage, serverless share, jobs share, spend trajectory) that set each workspace's health, plus estate cost drivers by product and SKU.",
    tables: ["system.billing.usage", "system.billing.list_prices"],
  },
  {
    id: "queries",
    label: "Query Advisor",
    description:
      "Statement fingerprints from query history — slow, spilling and capacity-heavy patterns with a wall-time breakdown (queue / compile / execute / fetch) and billed warehouse cost allocated by task time. AI reviews use SQL ai_query on the configured Claude endpoint, run as you — one per fingerprint, on demand or in a background batch.",
    tables: ["system.query.history", "system.billing.usage", "ai_query (LLM reviews)"],
    note: "The statement mirror, rollups and AI reviews live in the app's own store.",
  },
  {
    id: "tables",
    label: "Tables",
    description:
      "Inventory of Unity Catalog and legacy Hive-metastore objects, plus measured layout health of the most-read tables (size, files, clustering) with best-practice flags.",
    tables: [
      "system.information_schema.tables",
      "system.access.table_lineage",
      "system.storage.predictive_optimization_operations_history",
      "DESCRIBE DETAIL (per-table probes)",
      "hive_metastore (SHOW SCHEMAS / TABLES)",
    ],
  },
  {
    id: "governance",
    label: "Governance",
    description:
      "Cost-governance scorecard: tagged spend, Unity Catalog adoption, serverless and jobs share, compute hygiene (warehouse auto-stop, cluster auto-termination) and critical access flags.",
    tables: ["system.billing.usage", "system.compute.warehouses", "system.compute.clusters"],
    note: "Tiles also reuse the cached workspace facts, table inventory and access grants.",
  },
  {
    id: "tags",
    label: "Tags",
    description:
      "Tag coverage across billed usage and Unity Catalog — spend carrying each tag key, and per-tag search listing every resource and securable with its month-to-date cost.",
    tables: [
      "system.billing.usage (custom_tags)",
      "system.information_schema.*_tags (5 views)",
    ],
  },
  {
    id: "adoption",
    label: "Adoption & Value",
    description:
      "Who uses the platform and what for — monthly / weekly active users, product breadth per workspace, top users, and which curated tables are actually read downstream.",
    tables: [
      "system.billing.usage",
      "system.query.history",
      "system.access.table_lineage",
      "system.information_schema.tables",
    ],
  },
  {
    id: "genie",
    label: "Genie $",
    description:
      "Genie usage cost by surface, user and workspace, plus each space's SQL-warehouse compute attributed from query history.",
    tables: ["system.billing.usage", "system.query.history"],
  },
  {
    id: "ai",
    label: "AI $",
    description:
      "Spend across the AI product family — model serving, AI functions, vector search, agents — by product, endpoint, owner and workspace, with a 6-month trend.",
    tables: ["system.billing.usage", "system.billing.list_prices"],
  },
  {
    id: "apps",
    label: "Apps $",
    description:
      "Databricks Apps compute cost and runtime per app, lifecycle and declared resources from audit events, best-practice flags — plus out-of-the-box caller attribution of warehouse compute (on-behalf-of via the audit identity chain, service-principal via query history), hour-matched per warehouse-hour, and full-cost assets for resources declared by exactly one app.",
    tables: ["system.billing.usage", "system.access.audit (lifecycle + caller identity chain)", "system.query.history (hour-matched caller + genie-space attribution)"],
  },
  {
    id: "dqm",
    label: "Data Quality",
    description:
      "Monitors discovered from their Lakehouse-Monitoring output tables (profile/drift metrics), refresh freshness, and monitoring spend by workspace — quality statuses appear when the optional system table is granted.",
    tables: [
      "system.information_schema.tables (monitor outputs)",
      "system.billing.usage",
      "system.data_quality_monitoring.table_results (optional)",
    ],
  },
  {
    id: "recommendations",
    label: "Recommendations",
    description:
      "Prioritised findings composed from the other pages — query fixes, HMS migration, compute hygiene, jobs share and cost attribution — with suggested owners.",
    tables: [],
    note: "Composed from the cached objects of the pages above; no extra table scans of its own.",
  },
];

export function tablesForPage(id: PageId): string[] {
  return TAB_GUIDE.find((g) => g.id === id)?.tables ?? [];
}
