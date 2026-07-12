// Shared types for the FinOps Command Center frontend.

export type PageId =
  | "overview"
  | "access"
  | "workspaces"
  | "queries"
  | "tables"
  | "governance"
  | "tags"
  | "genie"
  | "ai"
  | "apps"
  | "adoption"
  | "recommendations"
  | "dqm"
  | "admin";

// Deploy-time feature flags. Read once from /api/config; gate the
// Ask Genie banner (genie), the Data Quality tab (dqm) and LLM narration
// (ai_narration). Deterministic recommender + Genie-cost are always on.
export interface Features {
  genie: boolean;
  ai_narration: boolean;
  dqm: boolean;
}

export type Health = "Good" | "Warning" | "Critical";
// Optimisation complexity: how much work optimising a workspace takes,
// rated from the measured serverless + interactive-compute shares.
export type Complexity = "Easy" | "Medium" | "Hard";
export type InsightType =
  | "cluster"
  | "resize"
  | "rewrite"
  | "vacuum"
  | "optimize"
  | "convert-to-managed"
  | "enable-PO"
  | "enable-LC";
export type Status = "Good" | "Warning" | "Critical";

// Freshness of a served cache object (24h TTL). Present on endpoints backed
// by a registered cache object; drives the "as of / refreshing" badge.
export interface CacheMeta {
  object: string;
  computed_at: string | null;
  age_seconds: number | null;
  ttl_seconds: number;
  refreshing: boolean;
  error: string | null;
}

// One row of the Configuration page's cached-data listing. scope: "user" = computed
// on-behalf-of-user, one cache row per viewer (permissions preserved);
// "shared" = computed with app credentials, one row for everyone.
export interface CacheStatusEntry extends CacheMeta {
  label: string;
  tab: string;
  queries: string;
  scope: "user" | "shared";
}

// Every API payload arrives in this envelope. Some endpoints (e.g.
// /api/tables) also attach a `summary` block of pre-aggregated KPIs; cached
// endpoints attach `cache` freshness meta.
export interface Envelope<T, S = unknown> {
  data: T;
  summary?: S;
  cache?: CacheMeta;
}

export interface CurrencyOption {
  code: string; // "USD" | "AUD"
  symbol: string;
  rate: number; // multiply a USD figure by this
  label: string;
}

export interface AppConfig {
  app_name: string;
  app_short: string;
  build?: string;
  customer: string;
  // The signed-in viewer (all estate reads run as this identity).
  viewer?: string | null;
  currencies?: CurrencyOption[];
  fx_aud?: number;
  base_currency?: string;
  features?: Features;
  genie_space_id?: string;
}

// Configuration-page payloads (read-only risk-flag documentation).
export interface RiskDefinition {
  flag: string;
  severity: "critical" | "warning";
  definition: string;
}

export interface AdminConfig {
  // Read-only: the exact rules behind the Access page's risk flags.
  risk_definitions?: { flags: RiskDefinition[]; notes: string[] };
}

// Adoption & value — all measured (billing identities, query history,
// billing_origin_product, table lineage reads × freshness).
export interface AdoptionFeatureRow {
  workspace: string;
  products: { product: string; dbus: number }[];
  breadth: number;
}

export interface AdoptionTopUser {
  user: string;
  workspace: string;
  queries_30d: number;
  last_active: string;
}

export interface ValueMapPoint {
  fqn: string;
  reads_30d: number;
  days_since_update: number;
  class: "gold" | "standard" | "archive";
}

export interface AdoptionReport {
  mau: number;
  wau: number;
  queries_month: number;
  genie_adopters: number;
  ai_adopters: number;
  feature_breadth_avg: number;
  num_products: number;
  all_products: string[];
  feature_matrix: AdoptionFeatureRow[];
  top_users: AdoptionTopUser[];
  value_map: ValueMapPoint[];
  num_gold: number;
  num_archive: number;
}

// Workspace-scope picker (Configuration page): the full (unscoped) workspace universe.
export interface AdminWorkspace {
  workspace_id: string;
  spend_usd_month: number;
  dbus_month: number;
  included: boolean;
}

export interface AdminWorkspacesResponse {
  data: AdminWorkspace[];
  scope_active: boolean;
  num_included: number;
  // When the stored list was last rebuilt from billing (Refresh button).
  computed_at?: string | null;
}

export interface TrendPoint {
  week: string;
  spend_usd: number;
  savings_usd: number | null; // null in live mode — realised savings not measurable
}

export interface TopOpportunity {
  type: "query" | "table" | "access" | "workspace";
  insight: string;
  target: string;
  est_savings_usd_month: number | null;
  detail: string;
}

export interface Overview {
  total_spend_usd_month: number;
  total_dbus_month: number;
  num_workspaces: number;
  num_critical: number;
  // Optimisation-complexity mix across workspaces.
  opt_easy: number;
  opt_medium: number;
  opt_hard: number;
  trend: TrendPoint[];
  top_opportunities: TopOpportunity[];
  cost_drivers: CostDrivers;
}

// One deterministic best-practice check applied to a workspace. n/a = the
// check does not apply to this workspace's workload mix.
export interface WorkspaceCheck {
  id: string;
  label: string;
  status: "pass" | "warn" | "fail" | "n/a";
  detail: string;
}

export interface Workspace {
  workspace_id: string;
  workspace: string;
  spend_usd_month: number;
  mom_pct: number | null; // run-rate vs last month; null when last month < $100
  tagged_pct: number;
  automated_pct: number;
  interactive_share: number;
  jobs_share: number | null; // null when classic compute is negligible
  serverless_share: number;
  health: Health;
  checks: WorkspaceCheck[];
  complexity: Complexity;
  dbus_month: number;
  num_clusters: number;
  num_warehouses: number;
}

export interface ProductMixSlice {
  product: string;
  pct: number;
  spend_usd_month: number;
}

export interface WorkspaceMonthPoint {
  month: string;
  spend_usd: number;
}

export interface SpendByEntity {
  spend_usd_month: number;
}

export interface TopUser extends SpendByEntity {
  user: string;
}

export interface TopJob extends SpendByEntity {
  job: string;
}

export interface TopWarehouse extends SpendByEntity {
  warehouse: string;
}

// --- Cost by cost-driver + SKU breakdown ------------------------

export interface DriverSlice {
  driver: string; // billing_origin_product code
  label: string;
  spend_usd_month: number;
  pct_of_total: number;
}

export interface DriverTrendPoint {
  month: string;
  spend_usd: number;
}

export interface DriverSeries {
  driver: string;
  label: string;
  points: DriverTrendPoint[];
  spend_usd_month: number;
}

export interface DriverMoM {
  driver: string;
  label: string;
  prev_usd_month: number;
  spend_usd_month: number;
  mom_pct: number;
  delta_usd: number;
}

export interface SkuRow {
  sku: string;
  driver: string;
  driver_label: string;
  total_cost: number;
  dbus_month: number;
  pct_of_total: number;
}

export interface DbuBySku {
  sku: string;
  driver: string;
  driver_label: string;
  dbus_month: number;
}

export interface CostDrivers {
  workspace?: string;
  total_spend_usd_month: number;
  drivers: DriverSlice[];
  sku_breakdown: SkuRow[];
  dbu_by_sku: DbuBySku[];
  trend: { months: string[]; series: DriverSeries[]; mom: DriverMoM[] };
  mom: DriverMoM[];
}

export interface WorkspaceDetail extends Workspace {
  product_mix: ProductMixSlice[];
  monthly_trend: WorkspaceMonthPoint[];
  top_users: TopUser[];
  top_jobs: TopJob[];
  top_warehouses: TopWarehouse[];
  cost_drivers: CostDrivers | null;
}

export type QueryFlag =
  | "slow"
  | "high-spill"
  | "capacity-bound"
  | "full-scan";

export interface QueryRow {
  id: number;
  statement_id: string;
  query_text: string;
  target_table?: string;
  insight_type: InsightType;
  insight_rationale: string;
  // ai_query review of this statement's SQL (per-fingerprint, computed once).
  ai_advice?: string | null;
  ai_pending?: boolean;
  rationale: string;
  impact: number;
  severity: number;
  warehouse: string;
  workspace: string;
  user: string;
  runs: number;
  p50_s: number;
  p95_s: number;
  bytes_read: number;
  pruning_efficiency: number;
  spill_gb: number;
  queued_ratio: number;
  cost_usd: number;
  flags: QueryFlag[];
  confidence: number | null; // null when no confidence model applies
  next_steps: string[];
  // Wall-time breakdown + provenance (measured; null for rows mirrored
  // before the breakdown columns existed — unknown, not zero).
  total_dur_s?: number;
  phase_shares?: Record<string, number> | null;
  read_rows?: number | null;
  produced_rows?: number | null;
  cached_runs?: number | null;
  client_app?: string;
  source_label?: string;
  last_run?: string;
  // Model behind ai_advice (ai_query endpoint), when a review exists.
  ai_model?: string | null;
}

// Real catalog metadata only (information_schema.tables + the legacy HMS
// listing). Physical layout is not collected, so it is not typed here.
export interface TableRow {
  fqn: string;
  catalog: string;
  schema: string;
  table: string;
  // MANAGED | EXTERNAL | FOREIGN | VIEW | MATERIALIZED_VIEW | STREAMING_TABLE
  // | METRIC_VIEW | HMS (legacy hive_metastore, flagged for migration)
  table_type: string;
  format: string;
  owner: string;
  created: string;
  last_altered: string;
  recommendation: InsightType | "None";
  needs_action: boolean;
  rationale: string;
  caveat?: string | null;
  next_steps: string[];
}

export interface TablesSummary {
  num_objects: number;
  num_managed: number;
  num_external: number;
  pct_managed: number;
  num_foreign: number;
  num_views: number;
  num_hms: number;
}

// Table layout health — measured facts only: DESCRIBE DETAIL probes (run as
// the viewer) + Predictive Optimization ops history. Flags are deterministic
// best-practice checks over those facts.
export interface TableFlag {
  id: string;
  label: string;
  action: string;
}

export interface TableProbe {
  fqn: string;
  table_type: string;
  format: string;
  size_bytes: number;
  num_files: number;
  avg_file_mb: number;
  partition_cols: string[];
  clustering_cols: string[];
  last_modified: string;
  po_ops_30d: number;
  po_last: string;
  po_types: string;
  flags: TableFlag[];
}

export interface TableHealthRow extends TableProbe {
  owner: string;
  reads_30d: number;
}

export interface TableHealth {
  criteria: string;
  probed: number;
  skipped_no_access: number;
  flagged: number;
  total_size_bytes: number;
  po_available: boolean;
  po_ops_30d_estate: number;
  rows: TableHealthRow[];
}

// --- Tags: coverage, key catalog and search ---------------------------------
// Sources: billing usage custom_tags (spend) and the five information_schema
// *_tags views (UC securables).

export interface TagProductCoverage {
  product: string;
  usd: number;
  tagged_usd: number;
  tagged_pct: number;
}

export interface TagKeyRow {
  key: string;
  usd: number;
  // Share of TOTAL spend whose rows carry this key — ≥50% usually means a
  // workspace-default or platform-injected blanket tag.
  pct_of_spend: number;
  num_values: number;
  securables: number;
  // Operator-excluded from coverage (blanket keys don't count as "tagged").
  excluded: boolean;
}

export interface TagsReport {
  total_usd: number;
  tagged_usd: number;
  tagged_pct: number;
  by_product: TagProductCoverage[];
  keys: TagKeyRow[];
  excluded_keys: string[];
  uc_counts: Record<string, number>;
  uc_total: number;
  distinct_keys_billing: number;
  distinct_keys_uc: number;
}

export interface TagResourceRow {
  asset_type: string;
  asset: string;
  workspace: string;
  tag_value: string;
  usd: number;
}

export interface TagSearchResult {
  key: string;
  value?: string | null;
  total_usd: number;
  resources: TagResourceRow[];
  by_value: { value: string; usd: number }[];
  securables: { level: string; securable: string; tag_value: string }[];
}

// --- Access: the direct grant graph ----------------------------------------

export interface Grant {
  id: number;
  principal: string;
  principal_type: string; // user | service_principal | group
  privilege: string;
  securable: string;
  level: "catalog" | "schema" | "table";
  catalog: string;
  schema: string | null;
  table: string | null;
  concern: "critical" | "warning" | null;
  concern_reason: string | null;
}

export type GovernancePageId = Exclude<PageId, "governance">;

export interface GovernanceTile {
  metric: string;
  category?: string;
  weight?: number;
  value_pct?: number;
  value_usd?: number;
  value_count?: number;
  status: Status;
  gap: string;
  action: string;
  ties_to?: GovernancePageId;
  score_points?: number;
}

export interface TaggingWorkspaceRow {
  workspace: string;
  spend_usd_month: number;
  tagging_pct: number;
  untagged_pct: number;
  untagged_usd_month: number;
  status: Status;
}

export interface GovernanceReport {
  score: number;
  grade: string;
  counts: Record<Status, number>;
  num_tiles: number;
  tiles: GovernanceTile[];
  tagging_by_workspace: TaggingWorkspaceRow[];
}

// --- Recommendations hub --------------------------------------

export type Priority = "P1" | "P2" | "P3";
export type RecCategory =
  | "behavioural"
  | "compute"
  | "storage"
  | "tagging"
  | "genai"
  | "access"
  | "governance";
export type RecScope = "global" | "workspace" | "bu" | "team" | "user" | "account";

export interface HubRec {
  id: string;
  category: RecCategory;
  priority: Priority;
  priority_score: number;
  title: string;
  scope: RecScope;
  scope_label: string;
  effort: "Low" | "Med" | "High";
  evidence: string[];
  what_to_do: string[];
  owner: string;
  workspace?: string | null;
}

export interface HubSummary {
  num_p1: number;
  num_recs: number;
  untagged_spend_usd_month: number;
  untagged_pct: number;
  top_category: RecCategory | null;
  category_counts: Record<string, number>;
  priority_counts: Record<Priority, number>;
  category_savings: Record<string, number>;
}

// Cost-attribution rollup on the Recommendations hub — every figure comes
// from objects shown elsewhere (governance tagging scan + cost drivers), so
// the numbers always agree across tabs.
export interface Attribution {
  total_spend_usd_month: number;
  total_untagged_usd_month: number;
  untagged_pct: number;
  by_workspace: TaggingWorkspaceRow[];
  cost_drivers: DriverSlice[];
  driver_spikes: DriverMoM[];
}

// --- Genie cost attribution — Code vs Spaces ----------

// Genie surface = usage_metadata.genie.surface. Real values: GENIE_CODE,
// GENIE_ONE, GENIE_AGENTS (+ UNKNOWN for the ~0.5% null rows). Not an enum —
// the column is undocumented and may add values, so treat surface as a string
// and render the server-supplied label.
export interface GenieCostRow {
  workspace: string;
  user_identity: string;
  surface: string;
  label: string;
  total_dbus: number;
  total_list_cost_usd: number;
}

export interface GenieSurfaceTotal {
  surface: string;
  label: string;
  dbus: number;
  list_usd: number;
  pct: number;
}

export interface GenieWorkspaceTotal {
  workspace: string;
  distinct_users: number;
  total_dbus: number;
  surface_dbus: Record<string, number>;
  total_list_cost_usd: number;
}

export interface GenieUserTotal {
  user_identity: string;
  total_dbus: number;
  total_list_cost_usd: number;
  num_workspaces: number;
  top_surface: string | null;
}

// Estimated SQL-warehouse compute per Genie space (query_source.genie_space_id
// in query history, hour-matched: each billed warehouse-hour split by that
// hour's task-time shares, denominator floored at one compute-hour). Genie
// DBUs themselves carry no space id in billing.
export interface GenieSpaceCost {
  space_id: string;
  title: string | null;
  queries: number;
  users: number;
  task_s: number;
  est_warehouse_usd: number;
}

export interface GenieCost {
  month: string;
  workspace: string;
  breakdown: GenieCostRow[];
  surface_totals: GenieSurfaceTotal[];
  by_workspace: GenieWorkspaceTotal[];
  by_user: GenieUserTotal[];
  by_space: GenieSpaceCost[];
  // Total platform spend this month, for the "% of total spend" context.
  total_platform_spend_usd_month?: number;
  summary: {
    total_dbus: number;
    total_list_cost_usd: number;
    distinct_users: number;
    num_workspaces: number;
    num_surfaces: number;
  };
  caveats: string[];
}

// --- Apps $ (Databricks Apps compute + related assets) ----------------------

export interface AppAsset {
  type: string;
  label: string;
  usd: number | null; // null = not attributable from billing (e.g. secrets)
  // "app" = genuinely attributable to this app; "shared" = resource total,
  // not separable per app; "full" = FULL resource cost carried by the
  // declaring app (Lakebase, declared jobs — asterisked, overstates when
  // shared); null = no billing signal at all.
  attribution: "app" | "shared" | "full" | null;
}

export interface AppCostRow {
  name: string;
  app_id: string;
  url: string;
  state: string;
  creator: string;
  created: string;
  updated: string;
  cost_usd: number;
  dbus: number;
  runtime_h: number;
  uptime_pct: number;
  assets: AppAsset[];
  assets_usd: number;
  assets_shared_usd: number;
  flags: string[];
  // OBO warehouse compute matched to this app by integration name.
  obo_usd?: number;
  // Full OBO detail for the expanded breakdown (null when none matched).
  obo?: { usd: number; statements: number; users: number; warehouses: string[] } | null;
  // assets_usd + obo_usd — the one attributed number shown on the row.
  linked_usd?: number;
}

// One OAuth app integration's on-behalf-of warehouse compute, from the
// audit identity chain × query-history task-share. name comes from the
// integration's creation audit event or an operator label ("" = unnamed).
export interface OboAttributionRow {
  // OAuth integration id (kind "obo") or SP application id (kind "sp").
  integration_id: string;
  kind: "obo" | "sp";
  name: string;
  name_source: "label" | "audit" | "";
  usd: number;
  statements: number;
  users: number;
  warehouses: string[];
}

export interface AppsCost {
  month: string;
  summary: {
    total_usd: number;
    num_apps: number;
    num_running: number;
    runtime_h: number;
    assets_usd: number;
    assets_shared_usd: number;
    obo_usd: number;
    full_usd: number;
    linked_usd: number;
  };
  apps: AppCostRow[];
  obo: {
    rows: OboAttributionRow[];
    total_usd: number;
    error: string | null;
  };
  caveats: string[];
}

// --- AI cost attribution (all AI billing products; always on) --------------

export interface AiProduct {
  code: string;
  label: string;
  list_usd: number;
  dbus: number;
  endpoints: number;
  pct: number;
}
export interface AiEndpoint {
  name: string;
  product: string;
  product_label: string;
  workspace: string;
  owner: string;
  list_usd_month: number;
  dbus_month: number;
  mode: string;
  gpu: boolean;
}
export interface AiUser {
  user: string;
  list_usd: number;
  endpoints: number;
  top_product: string | null;
}
export interface AiWorkspace {
  workspace: string;
  list_usd: number;
  endpoints: number;
}
// --- Data Quality Monitoring --------------

export type DqmQuality = "Good" | "Warning" | "Critical";
export type DqmFreshness = "Fresh" | "Stale" | "Unknown";

// A monitor DISCOVERED from its Lakehouse-Monitoring output tables
// (*_profile_metrics / *_drift_metrics), optionally enriched with the
// quality status from system.data_quality_monitoring.table_results when the
// viewer holds that grant (quality_status is null otherwise).
export interface DqmMonitor {
  fqn: string;
  catalog: string;
  schema: string;
  table: string;
  has_profile: boolean;
  has_drift: boolean;
  owner: string;
  last_refresh_hours: number | null;
  freshness: DqmFreshness;
  quality_status: DqmQuality | null;
  downstream: number | null;
}

export interface DqmSummary {
  num_monitors: number;
  num_visible: number;
  num_fresh: number;
  num_stale: number;
  // null when system.data_quality_monitoring.table_results isn't readable.
  num_critical: number | null;
  num_warning: number | null;
  dqm_cost_usd_month: number;
  dqm_dbus_month: number;
  results_available: boolean;
}

export interface DqmWorkspaceCost {
  workspace: string;
  cost_usd_month: number;
  dbus_month: number;
}

// Genie Ask SSE meta (mirrors GridSense's GenieMeta shape).
export interface GenieAskChart {
  type: "bar" | "line";
  labels: string[];
  values: number[];
  unit: string;
}

export interface GenieAskMeta {
  matched_question?: string;
  asked_question: string;
  chart?: GenieAskChart;
  follow_ups?: string[];
  source?: "genie" | "error";
  caveat?: string;
}
