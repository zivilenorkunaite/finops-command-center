import { useMemo, useState } from "react";
import { fetchGovernance } from "../api/client";
import { useCachedApi } from "../hooks/useCachedApi";
import { PageShell, LoadingCard, PageDataError } from "../components/layout/PageShell";
import { FilterBar, Dropdown } from "../components/shared/FilterBar";
import { GovernanceScore } from "../components/governance/GovernanceScore";
import { GovernanceTileCard } from "../components/governance/GovernanceTileCard";
import { TaggingTable } from "../components/governance/TaggingTable";
import type { GovernanceTile, Status } from "../types";

const STATUS_OPTIONS = [
  { value: "all", label: "All statuses" },
  { value: "Critical", label: "Critical" },
  { value: "Warning", label: "Warning" },
  { value: "Good", label: "Good" },
];

// Stable category ordering for grouped display.
const CATEGORY_ORDER = [
  "Cost attribution",
  "Budgets & alerts",
  "Storage optimisation",
  "Compute controls",
  "Data governance",
  "Access & identity",
  "Region & residency",
];

function groupByCategory(tiles: GovernanceTile[]): [string, GovernanceTile[]][] {
  const map = new Map<string, GovernanceTile[]>();
  for (const t of tiles) {
    const cat = t.category ?? "Other";
    if (!map.has(cat)) map.set(cat, []);
    map.get(cat)!.push(t);
  }
  const cats = [...map.keys()].sort(
    (a, b) => (CATEGORY_ORDER.indexOf(a) + 1 || 99) - (CATEGORY_ORDER.indexOf(b) + 1 || 99),
  );
  return cats.map((c) => [c, map.get(c)!]);
}

export function GovernancePage() {
  const [status, setStatus] = useState<string>("all");
  const { data, loading, error, cache, refresh } = useCachedApi(() => fetchGovernance({}), []);

  // Fetch the full report unfiltered, then filter client-side so the summary
  // score + tagging table stay stable while the tile grid narrows.
  const report = data?.data;

  const filteredTiles = useMemo(() => {
    if (!report) return [];
    if (status === "all") return report.tiles;
    return report.tiles.filter((t) => t.status === (status as Status));
  }, [report, status]);

  const grouped = useMemo(() => groupByCategory(filteredTiles), [filteredTiles]);

  return (
    <PageShell
      title="Governance"
      subtitle="Cost-governance posture and controls — each tile scored Good / Warning / Critical with the specific gap and next action"
      cache={cache}
      onRefresh={refresh}
    >
      {loading && <LoadingCard />}
      {error && <PageDataError pageId="governance" message={error} />}
      {report && (
        <>
          <GovernanceScore report={report} />


          <FilterBar>
            <Dropdown label="Status" value={status} onChange={setStatus} options={STATUS_OPTIONS} />
            <span className="text-xs text-neutral">
              {filteredTiles.length} of {report.num_tiles} controls
            </span>
          </FilterBar>

          {grouped.map(([category, tiles]) => (
            <div key={category} className="flex flex-col gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral">{category}</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {tiles.map((t) => (
                  <GovernanceTileCard key={t.metric} tile={t} />
                ))}
              </div>
            </div>
          ))}

          {filteredTiles.length === 0 && (
            <div className="card text-sm text-neutral py-8 text-center">
              No controls match the selected status.
            </div>
          )}

          <TaggingTable rows={report.tagging_by_workspace} />
        </>
      )}
    </PageShell>
  );
}
