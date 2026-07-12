import { useMemo, useState } from "react";
import { fetchQueries } from "../api/client";
import { useApi } from "../hooks/useApi";
import { useCachedApi } from "../hooks/useCachedApi";
import { PageShell, LoadingCard, PageDataError } from "../components/layout/PageShell";
import { DataTable } from "../components/shared/DataTable";
import type { Column } from "../components/shared/DataTable";
import { FilterBar, TimeRangeChips, Dropdown, SearchBox, ThresholdSlider } from "../components/shared/FilterBar";
import { KpiCard } from "../components/kpi/KpiCard";
import { InfoTip } from "../components/shared/InfoTip";
import { KpiRow } from "../components/kpi/KpiRow";
import { ScoreBar } from "../components/shared/ProgressBar";
import { QueryInsightCell } from "../components/queries/QueryInsightCell";
import { QueryDetail } from "../components/queries/QueryDetail";
import { FlagCount } from "../components/queries/QueryFlags";
import { fmtMoney } from "../components/shared/format";
import { useAppStore, useCurrency } from "../store/appStore";
import type { QueryRow } from "../types";

const FLAGS = ["all", "slow", "high-spill", "capacity-bound", "full-scan"];
const INSIGHT_TYPES = ["all", "capacity", "spill", "full-scan", "slow-query", "healthy"];


export function QueryAdvisorPage() {
  const cur = useCurrency();
  const globalWorkspace = useAppStore((s) => s.workspace);
  const [timeRange, setTimeRange] = useState("24h");
  const [warehouse, setWarehouse] = useState("all");
  const [workspace, setWorkspace] = useState("all");
  const [flag, setFlag] = useState("all");
  const [insightType, setInsightType] = useState("all");
  const [p95, setP95] = useState(0);
  const [search, setSearch] = useState("");

  // Effective workspace: page filter falls back to the global nav filter.
  const effWorkspace = workspace !== "all" ? workspace : globalWorkspace;

  const { data, loading, error, cache, refresh } = useCachedApi(
    () =>
      fetchQueries({
        time_range: timeRange,
        warehouse,
        workspace: effWorkspace,
        flag,
        insight_type: insightType,
        p95_threshold: p95,
        search,
      }),
    [timeRange, warehouse, effWorkspace, flag, insightType, p95, search],
  );

  // Unfiltered option lists (time-range-only) so dropdowns stay stable while
  // the user narrows other filters.
  const { data: allData } = useApi(() => fetchQueries({ time_range: timeRange }), [timeRange]);
  const warehouseOptions = useMemo(() => {
    const set = new Set((allData?.data ?? []).map((r) => r.warehouse));
    return ["all", ...Array.from(set).sort()];
  }, [allData]);
  const workspaceOptions = useMemo(() => {
    const set = new Set((allData?.data ?? []).map((r) => r.workspace));
    return ["all", ...Array.from(set).sort()];
  }, [allData]);

  const rows = data?.data ?? [];
  const kpis = {
    runs: rows.reduce((s, r) => s + r.runs, 0),
    critical: rows.filter((r) => r.severity === "High").length,
    computeH: rows.reduce((s, r) => s + (r.p95_s * r.runs) / 3600, 0),
    cost: rows.reduce((s, r) => s + r.cost_usd, 0),
    biggestSpill: rows.reduce((m, r) => Math.max(m, r.spill_gb), 0),
  };

  const columns: Column<QueryRow>[] = [
    {
      key: "idx",
      header: "#",
      align: "right",
      sortValue: (r) => r.impact,
      render: (r) => <span className="text-[11px] tabular-nums text-neutral">{rows.indexOf(r) + 1}</span>,
    },
    {
      key: "impact",
      header: (
        <span className="inline-flex items-center gap-1">
          Impact
          <InfoTip text="p95 runtime in seconds, capped at 100 — the slowest statements rank first." />
        </span>
      ),
      sortValue: (r) => r.impact,
      render: (r) => <ScoreBar score={r.impact} />,
    },
    {
      key: "query",
      header: "Query",
      sortValue: (r) => r.query_text,
      render: (r) => (
        <code className="text-xs font-mono text-brand-dark line-clamp-1 max-w-[260px] inline-block truncate align-middle">
          {r.query_text}
        </code>
      ),
    },
    {
      key: "insight",
      header: "AI Insight",
      sortValue: (r) => r.insight_type,
      render: (r) => <QueryInsightCell row={r} />,
    },
    { key: "warehouse", header: "Warehouse", sortValue: (r) => r.warehouse, render: (r) => <span className="text-xs font-mono">{r.warehouse}</span> },
    { key: "user", header: "User", sortValue: (r) => r.user, render: (r) => <span className="text-xs text-neutral">{r.user}</span> },
    { key: "runs", header: "Runs", align: "right", sortValue: (r) => r.runs, render: (r) => <span className="tabular-nums">{r.runs.toLocaleString("en-AU")}</span> },
    {
      key: "p95",
      header: (
        <span className="inline-flex items-center gap-1">
          p95
          <InfoTip text="95th-percentile query duration in seconds: 95 percent of runs finish faster. It captures the slow-run tail, not the typical run." />
        </span>
      ),
      align: "right",
      sortValue: (r) => r.p95_s,
      render: (r) => <span className="tabular-nums">{r.p95_s.toFixed(1)}s</span>,
    },
    { key: "cost", header: "Cost", align: "right", sortValue: (r) => r.cost_usd, render: (r) => <span className="tabular-nums">{fmtMoney(r.cost_usd, cur)}</span> },
    { key: "flags", header: "Flags", align: "center", sortValue: (r) => r.flags.length, render: (r) => <FlagCount flags={r.flags} /> },
  ];

  return (
    <PageShell
      title="Query Advisor"
      subtitle="Per-statement analytics from system.query.history — classified from measured metrics, with on-demand ai_query reviews (run as you)."
      cache={cache}
      onRefresh={refresh}
    >
      <KpiRow cols={5}>
        <KpiCard
          label="Runs"
          value={kpis.runs.toLocaleString("en-AU")}
          tone="neutral"
          info="Total number of times the queries in this view were executed over the selected time range."
        />
        <KpiCard
          label="Critical"
          value={String(kpis.critical)}
          tone="danger"
          hint="severity High"
          info="Statements with severity High: p95 of at least 120 seconds, or more than 5 GB spilled to disk."
        />
        <KpiCard
          label="Compute-h"
          value={kpis.computeH.toFixed(0)}
          tone="info"
          info="Estimated compute hours these queries consumed, from 95th-percentile duration multiplied by run count. Higher means more warehouse time spent."
        />
        <KpiCard
          label="Cost (window)"
          value={fmtMoney(kpis.cost, cur, { compact: true })}
          tone="accent"
          info="Each warehouse's billed cost over the selected window, allocated to its statements pro-rata by task time — an estimate; warehouse idle time is spread across the statements that ran. USD list price."
        />
        <KpiCard
          label="Biggest spill"
          value={`${kpis.biggestSpill.toFixed(0)} GB`}
          tone="warning"
          info="Largest volume of data any single query spilled from memory to disk. Spill signals the warehouse is undersized or the query is inefficient."
        />
      </KpiRow>

      <FilterBar>
        <TimeRangeChips value={timeRange} onChange={setTimeRange} options={["24h", "7d"]} />
        <Dropdown
          label="Warehouses"
          value={warehouse}
          onChange={setWarehouse}
          options={warehouseOptions.map((w) => ({ value: w, label: w === "all" ? "All warehouses" : w }))}
        />
        <Dropdown
          label="Workspaces"
          value={workspace}
          onChange={setWorkspace}
          options={workspaceOptions.map((w) => ({ value: w, label: w === "all" ? "All workspaces" : w }))}
        />
        <Dropdown
          label="Insight"
          value={insightType}
          onChange={setInsightType}
          options={INSIGHT_TYPES.map((t) => ({ value: t, label: t === "all" ? "All insights" : t }))}
        />
        <Dropdown label="Flags" value={flag} onChange={setFlag} options={FLAGS.map((f) => ({ value: f, label: f === "all" ? "All flags" : f }))} />
        <ThresholdSlider label="p95 ≥" value={p95} min={0} max={120} step={5} unit="s" onChange={setP95} />
        <SearchBox value={search} onChange={setSearch} placeholder="Search queries, users, warehouses…" />
      </FilterBar>

      {loading && !data && <LoadingCard />}
      {error && <PageDataError pageId="queries" message={error} />}
      {data && (
        <>
          <div className="flex items-center justify-between text-xs text-neutral px-1">
            <span>
              {rows.length} quer{rows.length === 1 ? "y" : "ies"} shown
            </span>
          </div>
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            initialSort={{ key: "impact", dir: "desc" }}
            renderExpanded={(r) => <QueryDetail row={r} />}
            emptyMessage="No queries match the current filters."
          />
        </>
      )}
    </PageShell>
  );
}
