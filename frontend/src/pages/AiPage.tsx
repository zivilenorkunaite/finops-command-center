import { useMemo, useState } from "react";
import { fetchAiCost } from "../api/client";
import { useCachedApi } from "../hooks/useCachedApi";
import { PageShell, LoadingCard, PageDataError } from "../components/layout/PageShell";
import { DataTable } from "../components/shared/DataTable";
import type { Column } from "../components/shared/DataTable";
import { FilterBar, Dropdown, SearchBox } from "../components/shared/FilterBar";
import { KpiCard } from "../components/kpi/KpiCard";
import { KpiRow } from "../components/kpi/KpiRow";
import { Pill } from "../components/shared/Pill";
import { InfoTip } from "../components/shared/InfoTip";
import { fmtMoney, fmtNum, fmtPct } from "../components/shared/format";
import { useCurrency } from "../store/appStore";
import type { AiEndpoint } from "../types";

// AI $ tab — all AI/GenAI billing products (Model Serving, AI Gateway,
// Vector Search, Agent Bricks, AI Functions, fine-tuning) by product, endpoint,
// owner and workspace. Genie has its own page.
// Deterministic billing attribution (calls no model), so ALWAYS on.

const PRODUCT_COLOR: Record<string, string> = {
  MODEL_SERVING: "bg-[#EC4899]",
  AI_GATEWAY: "bg-[#8B5CF6]",
  VECTOR_SEARCH: "bg-[#6366F1]",
  AGENT_BRICKS: "bg-[#0D9488]",
  AI_FUNCTIONS: "bg-[#F59E0B]",
  FOUNDATION_MODEL_TRAINING: "bg-[#C0392B]",
};
const productColor = (code: string) => PRODUCT_COLOR[code] ?? "bg-info";

export function AiPage() {
  const cur = useCurrency();
  const [workspace, setWorkspace] = useState("all");
  const [search, setSearch] = useState("");

  const { data, loading, error, cache, refresh } = useCachedApi(() => fetchAiCost({ workspace: workspace === "all" ? undefined : workspace }), [workspace]);
  const ai = data?.data;

  const wsOptions = useMemo(
    () => [
      { value: "all", label: "All workspaces" },
      ...(ai?.by_workspace ?? []).map((w) => ({ value: w.workspace, label: w.workspace })),
    ],
    [ai],
  );

  const endpoints = useMemo(() => {
    let e = ai?.endpoints ?? [];
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      e = e.filter((x) => x.name.toLowerCase().includes(q) || x.owner.toLowerCase().includes(q) || x.product_label.toLowerCase().includes(q));
    }
    return e;
  }, [ai, search]);

  const maxProduct = Math.max(1, ...(ai?.by_product ?? []).map((p) => p.list_usd));

  const endpointColumns: Column<AiEndpoint>[] = [
    { key: "name", header: "Endpoint / workload", sortValue: (e) => e.name, render: (e) => (
      <div className="flex flex-col gap-0.5 max-w-[240px]">
        <span className="font-mono text-xs text-brand-dark truncate">{e.name}</span>
        <span className="text-[11px] text-neutral">{e.workspace}</span>
      </div>
    ) },
    { key: "product", header: (<span className="inline-flex items-center gap-1">Product<InfoTip text="The AI billing product: Model Serving (incl. pay-per-token foundation models), AI Gateway, Vector Search, Agent Bricks, AI Functions, or fine-tuning/training." /></span>), sortValue: (e) => e.product_label, render: (e) => (
      <span className="inline-flex items-center gap-1.5"><span className={`h-2 w-2 rounded-sm ${productColor(e.product)}`} />{e.product_label}</span>
    ) },
    { key: "owner", header: "Owner", sortValue: (e) => e.owner, render: (e) => <span className="font-mono text-xs text-neutral truncate max-w-[170px] inline-block">{e.owner}</span> },
    { key: "mode", header: (<span className="inline-flex items-center gap-1">Mode<InfoTip text="How it bills: Pay-per-token (per request), Provisioned throughput (reserved capacity, bills 24x7), Serverless, Standard, or Job. GPU endpoints cost the most." /></span>), align: "center", sortValue: (e) => e.mode, render: (e) => (
      <span className="inline-flex items-center gap-1">
        <Pill className="bg-border/60 text-neutral">{e.mode}</Pill>
        {e.gpu && <Pill className="bg-danger/15 text-danger">GPU</Pill>}
      </span>
    ) },
    { key: "dbus", header: "DBUs", align: "right", sortValue: (e) => e.dbus_month, render: (e) => <span className="tabular-nums text-neutral">{fmtNum(e.dbus_month)}</span> },
    { key: "usd", header: (<span className="inline-flex items-center gap-1">$ / mo<InfoTip text="Endpoint cost this month at list price (DBUs times effective list rate)." /></span>), align: "right", sortValue: (e) => e.list_usd_month, render: (e) => <span className="tabular-nums">{fmtMoney(e.list_usd_month, cur)}</span> },
  ];

  const userColumns: Column<NonNullable<typeof ai>["by_user"][number]>[] = [
    { key: "user", header: "Owner", sortValue: (u) => u.user, render: (u) => <span className="font-mono text-xs text-brand-dark truncate max-w-[220px] inline-block">{u.user}</span> },
    { key: "top", header: "Top product", sortValue: (u) => u.top_product ?? "", render: (u) => <span className="text-xs">{u.top_product ?? "—"}</span> },
    { key: "eps", header: "Endpoints", align: "center", sortValue: (u) => u.endpoints, render: (u) => <span className="tabular-nums">{u.endpoints}</span> },
    { key: "usd", header: "$ / mo", align: "right", sortValue: (u) => u.list_usd, render: (u) => <span className="tabular-nums">{fmtMoney(u.list_usd, cur)}</span> },
  ];

  return (
    <PageShell
      title="AI spend"
      subtitle="All AI billing products — Model Serving, AI Gateway, Vector Search, Agent Bricks, AI Functions, fine-tuning — by product, endpoint, owner and workspace. Figures are list price. (Genie has its own tab.)"
      cache={cache}
      onRefresh={refresh}
    >
      {loading && !ai && <LoadingCard />}
      {error && <PageDataError pageId="ai" message={error} />}
      {ai && (
        <>
          <FilterBar>
            <Dropdown label="Workspace" value={workspace} onChange={setWorkspace} options={wsOptions} />
            <SearchBox value={search} onChange={setSearch} placeholder="Filter by endpoint, owner or product…" />
          </FilterBar>

          <KpiRow cols={5}>
            <KpiCard label="AI $ / mo" value={fmtMoney(ai.summary.total_list_usd_month, cur, { compact: true })} tone="accent"
              hint={ai.total_platform_spend_usd_month ? `${fmtPct(ai.summary.total_list_usd_month / ai.total_platform_spend_usd_month, 1)} of total spend` : "list price"}
              info="Total AI spend this month across all AI billing products (excludes Genie, which has its own page). The hint shows it as a share of total platform spend, for context." />
            <KpiCard label="GPU $ / mo" value={fmtMoney(ai.summary.gpu_usd_month, cur, { compact: true })} tone="danger" info="Spend on GPU-backed endpoints (model serving / training). GPUs are the most expensive AI compute — the first place to look for savings." />
            <KpiCard label="Endpoints" value={String(ai.summary.num_endpoints)} tone="info" info="Number of AI endpoints / workloads with spend this month (serving endpoints, vector indexes, agents, AI-function jobs, training runs)." />
            <KpiCard label="AI users" value={String(ai.summary.distinct_users)} info="Distinct owners of AI endpoints/workloads in the selected scope." />
            <KpiCard label="Products" value={String(ai.summary.num_products)} info="Distinct AI billing products in use (Model Serving, AI Gateway, Vector Search, Agent Bricks, AI Functions, fine-tuning)." />
          </KpiRow>

          {/* Spend by AI product */}
          <div className="card flex flex-col gap-3">
            <div className="text-sm font-semibold flex items-center gap-1.5">
              Spend by AI product
              <InfoTip text="AI spend grouped by billing_origin_product. Model Serving = hosted + pay-per-token models; AI Gateway = gateway usage; Vector Search = index compute; Agent Bricks = agent workloads; AI Functions = ai_* SQL functions; Fine-tuning = model training runs." />
            </div>
            <div className="flex flex-col gap-2.5">
              {ai.by_product.map((p) => (
                <div key={p.code} className="flex flex-col gap-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="flex items-center gap-1.5"><span className={`h-2.5 w-2.5 rounded-sm ${productColor(p.code)}`} />{p.label}</span>
                    <span className="tabular-nums text-neutral">{fmtMoney(p.list_usd, cur, { compact: true })} · {p.endpoints} ep · {fmtPct(p.pct, 1)}</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-border/60 overflow-hidden">
                    <div className={`h-full rounded-full ${productColor(p.code)}`} style={{ width: `${(p.list_usd / maxProduct) * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </div>


          {/* Endpoints */}
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold flex items-center gap-1.5">
              AI endpoints & workloads
              <InfoTip text="Every AI endpoint / workload with spend: product, owner, billing mode, GPU, DBUs and $/mo. Sort by $ to find the biggest line items." />
              {endpoints.length > 150 && <span className="text-xs font-normal text-neutral">top 150 of {endpoints.length} by $</span>}
            </h3>
            <DataTable columns={endpointColumns} rows={endpoints.slice(0, 150)} rowKey={(e) => `${e.workspace}|${e.name}`} initialSort={{ key: "usd", dir: "desc" }} emptyMessage="No AI spend for this scope." />
          </div>

          {/* Top AI users */}
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold flex items-center gap-1.5">
              Top AI owners
              <InfoTip text="Owners ranked by AI spend across their endpoints — who is driving AI cost and which product dominates for them." />
            </h3>
            <DataTable columns={userColumns} rows={ai.by_user} rowKey={(u) => u.user} initialSort={{ key: "usd", dir: "desc" }} emptyMessage="No AI owners for this scope." />
          </div>

          {/* Caveats */}
          <div className="card flex flex-col gap-2 py-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-neutral">How to read this</div>
            <ul className="flex flex-col gap-1 text-[11px] text-neutral">
              {ai.caveats.map((c, i) => (
                <li key={i} className="flex gap-1.5"><span className="text-warning shrink-0" aria-hidden>·</span><span>{c}</span></li>
              ))}
            </ul>
          </div>
        </>
      )}
    </PageShell>
  );
}
