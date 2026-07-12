import { useState } from "react";
import { fetchRecommendationsHub, fetchWorkspaces } from "../api/client";
import { useApi } from "../hooks/useApi";
import { useCachedApi } from "../hooks/useCachedApi";
import { PageShell, LoadingCard, PageDataError } from "../components/layout/PageShell";
import { DataTable } from "../components/shared/DataTable";
import type { Column } from "../components/shared/DataTable";
import { FilterBar, Dropdown, SearchBox } from "../components/shared/FilterBar";
import { KpiCard } from "../components/kpi/KpiCard";
import { KpiRow } from "../components/kpi/KpiRow";
import { fmtMoney, fmtPct } from "../components/shared/format";
import { InfoTip } from "../components/shared/InfoTip";
import { useCurrency } from "../store/appStore";
import { PriorityPill, CategoryPill, EffortChip, EvidenceChips } from "../components/recommendations/RecPills";
import { RecCard } from "../components/recommendations/RecCard";
import { CostAttributionPanel } from "../components/recommendations/CostAttributionPanel";
import type { HubRec, Priority } from "../types";

const CATEGORY_OPTIONS = [
  { value: "all", label: "All categories" },
  { value: "behavioural", label: "Behavioural / enablement" },
  { value: "compute", label: "Compute" },
  { value: "storage", label: "Storage" },
  { value: "tagging", label: "Tagging & attribution" },
  { value: "genai", label: "AI / GenAI spend" },
  { value: "access", label: "Access & governance" },
  { value: "governance", label: "Governance" },
];

const SCOPE_OPTIONS = [
  { value: "all", label: "All scopes" },
  { value: "global", label: "Estate-wide" },
  { value: "workspace", label: "Workspace" },
];

const PRIORITIES: Priority[] = ["P1", "P2", "P3"];

const CATEGORY_LABEL: Record<string, string> = {
  behavioural: "Behavioural",
  compute: "Compute",
  storage: "Storage",
  tagging: "Tagging",
  genai: "AI / GenAI",
  access: "Access",
  governance: "Governance",
};

export function RecommendationsPage() {
  const cur = useCurrency();
  const [view, setView] = useState<"overall" | "workspace">("overall");
  const [workspace, setWorkspace] = useState("all");
  const [priority, setPriority] = useState("all");
  const [category, setCategory] = useState("all");
  const [scope, setScope] = useState("all");
  const [search, setSearch] = useState("");

  const wsData = useApi(() => fetchWorkspaces({}), []);
  const workspaces = wsData.data?.data ?? [];

  // In per-workspace view the workspace filter is required; in overall view it
  // is forced to "all" so the estate ranking is shown.
  const effectiveWorkspace = view === "workspace" ? workspace : "all";

  const { data, loading, error, cache, refresh } = useCachedApi(
    () => fetchRecommendationsHub({ workspace: effectiveWorkspace, priority, category, scope }),
    [effectiveWorkspace, priority, category, scope],
  );

  const recs = data?.data ?? [];
  const summary = data?.summary;
  const attribution = data?.attribution;

  // client-side search over title / scope / evidence
  const filtered = search
    ? recs.filter((r) => {
        const s = search.toLowerCase();
        return (
          r.title.toLowerCase().includes(s) ||
          r.scope_label.toLowerCase().includes(s) ||
          r.evidence.some((e) => e.toLowerCase().includes(s))
        );
      })
    : recs;

  const columns: Column<HubRec>[] = [
    {
      key: "priority",
      header: (
        <span className="inline-flex items-center gap-1">
          Pri
          <InfoTip text="Priority tier from P1 to P3. P1 is critical, the highest impact and most urgent plays to act on first; P3 is lowest priority." />
        </span>
      ),
      align: "center",
      sortValue: (r) => ({ P1: 0, P2: 1, P3: 2 }[r.priority]),
      render: (r) => <PriorityPill priority={r.priority} />,
    },
    {
      key: "category",
      header: "Category",
      align: "center",
      sortValue: (r) => r.category,
      render: (r) => <CategoryPill category={r.category} />,
    },
    {
      key: "title",
      header: "Recommendation",
      sortValue: (r) => r.title,
      render: (r) => (
        <div className="flex flex-col gap-1 max-w-[520px]">
          <div className="font-medium leading-snug">{r.title}</div>
          <div className="text-xs text-neutral">
            <span className="font-mono">{r.scope_label}</span>
          </div>
          <EvidenceChips evidence={r.evidence} />
        </div>
      ),
    },
    {
      key: "effort",
      header: (
        <span className="inline-flex items-center gap-1">
          Effort
          <InfoTip text="Rough implementation effort to complete the play, rated Low, Med, or High. Use it with estimated savings to weigh quick wins against bigger projects." />
        </span>
      ),
      align: "center",
      sortValue: (r) => ({ Low: 0, Med: 1, High: 2 }[r.effort]),
      render: (r) => <EffortChip effort={r.effort} />,
    },
    {
      key: "owner",
      header: "Owner",
      sortValue: (r) => r.owner,
      render: (r) => <span className="text-xs text-neutral">{r.owner}</span>,
    },
  ];

  return (
    <PageShell
      title="Recommendations"
      subtitle="Unified advisor hub — every cost-optimisation finding across the estate, scored by priority and $."
      cache={cache}
      onRefresh={refresh}
    >
      {loading && !data && <LoadingCard />}
      {error && <PageDataError pageId="recommendations" message={error} />}

      {summary && (
        <KpiRow cols={4}>
          <KpiCard label="P1 recommendations" value={String(summary.num_p1)} tone="danger" hint="do first" info="Count of priority 1 plays, the highest impact and most urgent recommendations. Start with these to capture the most savings or reduce the most risk first." />
          <KpiCard label="Total recommendations" value={String(summary.num_recs)} tone="accent" info="Total number of recommended operator actions across the estate, spanning all priorities and categories, that match the current filters." />
          <KpiCard
            label="Untagged spend / mo"
            value={fmtMoney(summary.untagged_spend_usd_month, cur, { compact: true })}
            tone="warning"
            delta={{ text: fmtPct(summary.untagged_pct), tone: "negative" }}
            hint="cannot attribute"
            info="Dollars per month of spend that lacks cost attribution tags, so it cannot be charged back to a business unit, project, or owner. The percentage is its share of total spend."
          />
          <KpiCard
            label="Top category"
            value={summary.top_category ? CATEGORY_LABEL[summary.top_category] ?? summary.top_category : "—"}
            tone="info"
            hint="by savings"
            info="The recommendation category with the largest estimated savings, showing where the biggest cost optimization opportunity sits right now."
          />
        </KpiRow>
      )}

      {/* View toggle: Overall (estate ranking) vs Per-workspace */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-lg border border-border overflow-hidden">
          {(["overall", "workspace"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={`px-3.5 py-1.5 text-xs font-medium transition ${
                view === v ? "bg-accent text-white" : "text-neutral hover:text-brand-dark hover:bg-surface"
              }`}
            >
              {v === "overall" ? "Overall" : "Per-workspace"}
            </button>
          ))}
        </div>
        {view === "workspace" && (
          <Dropdown
            label="Workspace"
            value={workspace}
            onChange={setWorkspace}
            options={[
              { value: "all", label: "All workspaces" },
              ...workspaces.map((w) => ({ value: w.workspace, label: w.workspace })),
            ]}
          />
        )}
        <span className="text-xs text-neutral">
          {view === "overall"
            ? "Ranked by priority then $ across the whole estate"
            : "Recs scoped to the selected workspace (its BU + estate-wide plays)"}
        </span>
      </div>

      <FilterBar>
        <span className="text-xs text-neutral">Priority</span>
        <div className="inline-flex rounded-lg border border-border overflow-hidden">
          <button
            type="button"
            onClick={() => setPriority("all")}
            className={`px-2.5 py-1 text-xs font-medium transition ${
              priority === "all" ? "bg-accent text-white" : "text-neutral hover:text-brand-dark hover:bg-surface"
            }`}
          >
            All
          </button>
          {PRIORITIES.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPriority(p)}
              className={`px-2.5 py-1 text-xs font-medium transition ${
                priority === p ? "bg-accent text-white" : "text-neutral hover:text-brand-dark hover:bg-surface"
              }`}
            >
              {p}
              {summary && <span className="opacity-70"> · {summary.priority_counts[p] ?? 0}</span>}
            </button>
          ))}
        </div>
        <Dropdown label="Category" value={category} onChange={setCategory} options={CATEGORY_OPTIONS} />
        <Dropdown label="Scope" value={scope} onChange={setScope} options={SCOPE_OPTIONS} />
        <SearchBox value={search} onChange={setSearch} placeholder="Search recommendations…" />
      </FilterBar>

      {data && (
        <DataTable
          columns={columns}
          rows={filtered}
          rowKey={(r) => r.id}
          initialSort={{ key: "priority", dir: "asc" }}
          emptyMessage="No recommendations match the current filters."
          renderExpanded={(r) => <RecCard rec={r} />}
        />
      )}

      {attribution && <CostAttributionPanel attribution={attribution} workspace={effectiveWorkspace} />}
    </PageShell>
  );
}
