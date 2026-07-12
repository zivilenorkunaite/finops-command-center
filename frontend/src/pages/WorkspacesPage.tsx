import { useMemo, useState } from "react";
import { fetchWorkspaces, fetchCostDrivers } from "../api/client";
import { useApi } from "../hooks/useApi";
import { useCachedApi } from "../hooks/useCachedApi";
import { useCurrency } from "../store/appStore";
import { PageShell, LoadingCard, PageDataError } from "../components/layout/PageShell";
import { DataTable } from "../components/shared/DataTable";
import type { Column } from "../components/shared/DataTable";
import { FilterBar, Dropdown, SearchBox } from "../components/shared/FilterBar";
import { KpiCard } from "../components/kpi/KpiCard";
import { KpiRow } from "../components/kpi/KpiRow";
import { InfoTip } from "../components/shared/InfoTip";
import { StatusPill, Pill } from "../components/shared/Pill";
import { fmtMoney, fmtPct } from "../components/shared/format";
import { WorkspaceDetail } from "../components/workspaces/WorkspaceDetail";
import {
  DriverBar,
  DriverTrendChart,
  MoMChangeBar,
  SkuStackedBar,
  DbuBySkuBar,
  SkuBreakdownTable,
} from "../components/charts/CostDriverCharts";
import type { Workspace } from "../types";

type WorkspacesView = "workspaces" | "sku";

export function WorkspacesPage() {
  const cur = useCurrency();
  const [view, setView] = useState<WorkspacesView>("workspaces");
  const [complexity, setComplexity] = useState("all");
  const [health, setHealth] = useState("all");
  const [search, setSearch] = useState("");
  const { data, loading, error, cache, refresh } = useCachedApi(
    () => fetchWorkspaces({ complexity, health, search }),
    [complexity, health, search],
  );

  // No Customer/BU facet: billing carries no BU dimension in live mode, so
  // that dropdown could only ever offer a blank entry.
  const rows = data?.data ?? [];

  // KPI summary reconciles to the currently filtered rows.
  const totalSpend = rows.reduce((s, r) => s + r.spend_usd_month, 0);
  const applicable = rows.flatMap((r) => r.checks.filter((c) => c.status !== "n/a"));
  const passing = applicable.filter((c) => c.status === "pass").length;
  const critical = rows.filter((r) => r.health === "Critical").length;
  const hard = rows.filter((r) => r.complexity === "Hard").length;

  const columns: Column<Workspace>[] = [
    { key: "workspace", header: "Workspace", sortValue: (r) => r.workspace, render: (r) => (
      <div className="font-medium">{r.workspace}</div>
    ) },
    { key: "spend", header: "Spend/mo", align: "right", sortValue: (r) => r.spend_usd_month, render: (r) => <span className="tabular-nums">{fmtMoney(r.spend_usd_month, cur, { compact: true })}</span> },
    { key: "mom", header: (
      <span className="inline-flex items-center gap-1">MoM<InfoTip text="This month's spend projected to a full month (run-rate) versus last month's actual. — when last month had under $100 to compare against." /></span>
    ), align: "right", sortValue: (r) => r.mom_pct ?? -999, render: (r) => (
      r.mom_pct == null ? <span className="text-neutral text-xs">—</span>
      : <span className={`tabular-nums ${r.mom_pct > 0.25 ? "text-danger" : r.mom_pct < 0 ? "text-success" : "text-neutral"}`}>{r.mom_pct > 0 ? "+" : ""}{fmtPct(r.mom_pct)}</span>
    ) },
    { key: "checks", header: (
      <span className="inline-flex items-center gap-1">Checks<InfoTip text="Best-practice checks: tagging, serverless share, jobs-over-interactive, spend trajectory. Expand the row for each check's detail." /></span>
    ), align: "center", sortValue: (r) => r.checks.filter((c) => c.status === "fail").length * 100 + r.checks.filter((c) => c.status === "warn").length, render: (r) => {
      const p = r.checks.filter((c) => c.status === "pass").length;
      const w = r.checks.filter((c) => c.status === "warn").length;
      const x = r.checks.filter((c) => c.status === "fail").length;
      return (
        <span className="inline-flex gap-1 tabular-nums">
          {p > 0 && <span className="pill bg-success/15 text-success">{p} ✓</span>}
          {w > 0 && <span className="pill bg-warning/15 text-warning">{w} ⚠</span>}
          {x > 0 && <span className="pill bg-danger/15 text-danger">{x} ✗</span>}
        </span>
      );
    } },
    { key: "health", header: "Health", align: "center", sortValue: (r) => r.health, render: (r) => <StatusPill status={r.health} /> },
    { key: "complexity", header: (
      <span className="inline-flex items-center gap-1">Complexity<InfoTip text="How much work optimising this workspace takes, from the measured shares: Easy = ≥60% serverless with ≤10% interactive classic compute (incremental tuning). Hard = <30% serverless with >40% interactive (structural migration). Medium = in between." /></span>
    ), align: "center", sortValue: (r) => r.complexity, render: (r) => (
      <Pill className={r.complexity === "Easy" ? "bg-success/15 text-success" : r.complexity === "Hard" ? "bg-danger/15 text-danger" : "bg-info/15 text-info"}>{r.complexity}</Pill>
    ) },
  ];

  return (
    <PageShell title="Workspaces" subtitle="Workspace-by-workspace cost, automation, and optimization health" cache={cache} onRefresh={refresh}>
      {loading && <LoadingCard />}
      {error && <PageDataError pageId="workspaces" message={error} />}
      {data && (
        <>
          <KpiRow cols={5}>
            <KpiCard label="Workspaces" value={String(rows.length)} tone="neutral" info="Number of Databricks workspaces matching the current filters. Fewer, well-governed workspaces are easier to control for cost." />
            <KpiCard label="Spend / mo" value={fmtMoney(totalSpend, cur, { compact: true })} tone="accent" hint={cur.code === "USD" ? "list price" : `× ${cur.rate} FX`} info="Total monthly spend across the filtered workspaces, computed as Databricks Units consumed times the effective list price. This is the main cost number to watch." />
            <KpiCard label="Checks passing" value={applicable.length ? `${passing}/${applicable.length}` : "—"} tone="info" hint="applicable best-practice checks" info="Best-practice checks passing across the filtered workspaces: cost-attribution tagging, serverless share, jobs-over-interactive compute, and spend trajectory. Checks that do not apply to a workspace's mix (e.g. jobs share on a serving-only workspace) are excluded." />
            <KpiCard label="Critical" value={String(critical)} tone="danger" hint="a check failed" info="Workspaces where at least one applicable best-practice check FAILS (expand a row to see which). Warning = no failures but at least one warning-level check." />
            <KpiCard label="Hard to optimise" value={String(hard)} tone="warning" hint="structural work" info="Workspaces rated Hard: under 30% serverless with a heavy interactive-compute share, so optimising them means migrating workloads, not tuning. Higher counts mean more hands-on cost work remains." />
          </KpiRow>

          {/* View toggle: workspace table vs By Service / SKU sub-view */}
          <div className="inline-flex rounded-lg border border-border overflow-hidden w-fit">
            {([
              ["workspaces", "Workspaces"],
              ["sku", "By Service / SKU"],
            ] as [WorkspacesView, string][]).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setView(id)}
                className={`px-3.5 py-1.5 text-xs font-medium transition ${
                  view === id ? "bg-accent text-white" : "text-neutral hover:text-brand-dark hover:bg-surface"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {view === "workspaces" && (
            <>
              <FilterBar>
                <Dropdown label="Complexity" value={complexity} onChange={setComplexity} options={[
                  { value: "all", label: "All" }, { value: "Easy", label: "Easy" }, { value: "Medium", label: "Medium" }, { value: "Hard", label: "Hard" },
                ]} />
                <Dropdown label="Health" value={health} onChange={setHealth} options={[
                  { value: "all", label: "All" }, { value: "Good", label: "Good" }, { value: "Warning", label: "Warning" }, { value: "Critical", label: "Critical" },
                ]} />
                <SearchBox value={search} onChange={setSearch} placeholder="Search workspace or BU…" />
              </FilterBar>

              <div className="text-xs text-neutral -mt-1">
                Health = worst applicable best-practice check (tagging · serverless · jobs-over-interactive · spend trajectory); checks that don't fit a workspace's mix are skipped. Click a row for the check details, cost-by-driver &amp; SKU breakdown.
              </div>

              <DataTable
                columns={columns}
                rows={rows}
                rowKey={(r) => r.workspace_id}
                initialSort={{ key: "spend", dir: "desc" }}
                renderExpanded={(r) => <WorkspaceDetail workspaceId={r.workspace_id} />}
              />
            </>
          )}

          {view === "sku" && <SkuSubView />}
        </>
      )}
    </PageShell>
  );
}

// "By Service / SKU" sub-view: estate-or-workspace cost-by-
// driver + monthly trend + cost-by-SKU stacked + DBU-by-SKU + MoM spike + the
// SKU-level table with total_cost + pct_of_total.
function SkuSubView() {
  const cur = useCurrency();
  // Scope the SKU view by an individual workspace, or the whole estate.
  const [scope, setScope] = useState("all");
  const { data: wsData } = useApi(() => fetchWorkspaces({}), []);
  const wsOptions = useMemo(() => {
    const list = wsData?.data ?? [];
    return [
      { value: "all", label: "Whole estate" },
      ...list.map((w) => ({ value: w.workspace, label: w.workspace })),
    ];
  }, [wsData]);

  const { data, loading, error } = useApi(
    () => fetchCostDrivers({ workspace: scope }),
    [scope],
  );

  return (
    <div className="flex flex-col gap-4">
      <FilterBar>
        <Dropdown label="Scope" value={scope} onChange={setScope} options={wsOptions} />
      </FilterBar>

      {loading && <LoadingCard />}
      {error && <PageDataError pageId="workspaces" message={error} />}
      {data && (
        <>
          <KpiRow cols={3}>
            <KpiCard label="Scope spend / mo" value={fmtMoney(data.data.total_spend_usd_month, cur, { compact: true })} tone="accent" info="Total monthly spend for the selected scope, whole estate or one workspace, as Databricks Units times effective list price. The base for the breakdowns below." />
            <KpiCard label="Cost drivers" value={String(data.data.drivers.length)} tone="info" hint="billing_origin_product" info="Number of distinct products driving spend, such as DBSQL, Jobs, or Model Serving. Fewer concentrated drivers make cost easier to target." />
            <KpiCard label="SKUs" value={String(data.data.sku_breakdown.length)} tone="neutral" hint="sku_name" info="Number of distinct billing SKUs in this scope. Each SKU is a separately priced product and region line, useful for pinpointing where cost sits." />
          </KpiRow>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <DriverBar drivers={data.data.drivers} />
            <DriverTrendChart trend={data.data.trend} />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <SkuStackedBar skus={data.data.sku_breakdown} />
            <MoMChangeBar mom={data.data.mom} />
          </div>
          <DbuBySkuBar dbu={data.data.dbu_by_sku} />

          <div>
            <div className="flex items-baseline justify-between mb-2">
              <h3 className="text-sm font-semibold flex items-center gap-1.5">
                SKU-level breakdown
                <InfoTip text="A SKU is a single priced product and region billing line. This table shows each SKU's total cost and its share of scope spend, so you can see exactly where money goes." />
              </h3>
              <span className="text-xs text-neutral">total_cost · % of total by SKU</span>
            </div>
            <SkuBreakdownTable skus={data.data.sku_breakdown} />
          </div>
        </>
      )}
    </div>
  );
}
