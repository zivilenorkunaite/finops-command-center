import { StatusPill } from "../shared/Pill";
import { InfoTip } from "../shared/InfoTip";
import { ProgressBar } from "../shared/ProgressBar";
import { fmtMoney, fmtPct } from "../shared/format";
import type { MoneyCurrency } from "../shared/format";
import { useAppStore, useCurrency } from "../../store/appStore";
import type { GovernancePageId, GovernanceTile, Status } from "../../types";

const BORDER: Record<Status, string> = {
  Good: "border-l-success",
  Warning: "border-l-warning",
  Critical: "border-l-danger",
};

// map a tile status to a ProgressBar tone
const BAR_TONE: Record<Status, "success" | "warning" | "danger"> = {
  Good: "success",
  Warning: "warning",
  Critical: "danger",
};

// Plain-language definition per tile, keyed by the tile's metric name —
// exactly the tiles governance_live emits.
const TILE_INFO: Record<string, string> = {
  "Tagged spend (cost attribution)":
    "Share of month-to-date spend on resources that carry cost-attribution tags (system.billing.usage.custom_tags). Blanket keys excluded by the operator on the Tags tab don't count. Higher means more spend can be traced to a business unit or cost centre.",
  "Unity Catalog adoption (tables)":
    "Share of inventoried tables governed by Unity Catalog rather than the legacy hive_metastore. HMS tables have no lineage, fine-grained grants or system-table coverage.",
  "Serverless share of spend":
    "Share of month-to-date DBUs on serverless SKUs. Serverless scales to zero and removes idle burn; a low share means classic clusters are accumulating waste.",
  "Automated (jobs) share of usage":
    "Share of month-to-date DBUs from JOBS/DLT workloads. Interactive all-purpose compute bills at a higher rate and idles between commands.",
  "Warehouses without auto-stop":
    "Live SQL warehouses with auto_stop_minutes = 0 (system.compute.warehouses). An idle warehouse that never stops bills continuously — set a 10–15 minute auto-stop or use serverless.",
  "Clusters without auto-termination":
    "Live all-purpose clusters with no auto-termination (system.compute.clusters). A forgotten cluster bills until someone notices — set 30–60 minutes and enforce it with a cluster policy.",
  "Critical access risk flags":
    "Count of critical risk flags over direct Unity Catalog grants — the same deterministic rules as the Access page (definitions on the Configuration page). Zero is the target.",
};

const PAGE_LABEL: Record<GovernancePageId, string> = {
  overview: "Overview",
  access: "Access",
  workspaces: "Workspaces",
  queries: "Query Advisor",
  tables: "Tables",
  tags: "Tags",
  genie: "Genie $",
  ai: "AI $",
  apps: "Apps $",
  adoption: "Adoption & Value",
  recommendations: "Recommendations",
  dqm: "Data Quality",
  admin: "Configuration",
};

function tileValue(t: GovernanceTile, cur: MoneyCurrency): string {
  if (t.value_pct !== undefined) return fmtPct(t.value_pct);
  if (t.value_usd !== undefined) return fmtMoney(t.value_usd, cur, { compact: true });
  if (t.value_count !== undefined) return String(t.value_count);
  return "—";
}

export function GovernanceTileCard({ tile }: { tile: GovernanceTile }) {
  const setActivePage = useAppStore((s) => s.setActivePage);
  const cur = useCurrency();
  const showBar = tile.value_pct !== undefined;

  return (
    <div className={`card border-l-4 ${BORDER[tile.status]} flex flex-col gap-2`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <span className="text-sm font-medium flex items-center gap-1">
            <span className="truncate">{tile.metric}</span>
            {TILE_INFO[tile.metric] && <InfoTip text={TILE_INFO[tile.metric]} label={`What is ${tile.metric}?`} />}
          </span>
          {tile.category && (
            <span className="text-[10px] uppercase tracking-wide text-neutral">{tile.category}</span>
          )}
        </div>
        <StatusPill status={tile.status} />
      </div>

      <div className="text-2xl font-semibold tabular-nums leading-none">{tileValue(tile, cur)}</div>

      {showBar && (
        <ProgressBar value={tile.value_pct ?? 0} tone={BAR_TONE[tile.status]} showPct={false} />
      )}

      <div className="text-xs text-neutral">{tile.gap}</div>

      <div className="text-xs mt-1 pt-2 border-t border-border/60">
        <span className="text-neutral">Next: </span>
        {tile.action}
      </div>

      {tile.ties_to && (
        <div className="flex items-center flex-wrap gap-2 mt-1">
          {tile.ties_to && (
            <button
              type="button"
              onClick={() => setActivePage(tile.ties_to as GovernancePageId)}
              className="pill bg-border/40 text-neutral hover:text-brand-dark transition"
              title={`Open the ${PAGE_LABEL[tile.ties_to]} page`}
            >
              → {PAGE_LABEL[tile.ties_to]}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
