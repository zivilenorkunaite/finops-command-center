import { fetchWorkspaceDetail } from "../../api/client";
import { useApi } from "../../hooks/useApi";
import { useCurrency } from "../../store/appStore";
import { LoadingCard, PageDataError } from "../layout/PageShell";
import { StatusPill, Pill } from "../shared/Pill";
import { InfoTip } from "../shared/InfoTip";
import { fmtMoney, fmtPct, fmtNum } from "../shared/format";
import type { MoneyCurrency } from "../shared/format";
import { WorkspaceTrendChart } from "./WorkspaceTrendChart";
import { GenieSpendCard } from "../genie/GenieSpendCard";
import {
  DriverBar,
  DriverTrendChart,
  MoMChangeBar,
  SkuStackedBar,
  DbuBySkuBar,
  SkuBreakdownTable,
} from "../charts/CostDriverCharts";
import type {
  SpendByEntity,
  ProductMixSlice,
  WorkspaceDetail as WorkspaceDetailT,
} from "../../types";

// Product/SKU colour ramp — stable order, distinct hues (design-system palette).
const PRODUCT_COLORS: Record<string, string> = {
  "Serverless SQL": "#0D9488",
  "Serverless Jobs": "#1B8A4A",
  "DLT / Lakeflow": "#3B82F6",
  "Jobs Classic": "#8B5CF6",
  "All-Purpose Compute": "#F59E0B",
  "SQL Warehouse (Classic)": "#C0392B",
  "Model Serving": "#EC4899",
  Apps: "#14B8A6",
  "Foundation Model APIs": "#6366F1",
  "Predictive Optimization": "#84CC16",
};

function colorFor(product: string, i: number): string {
  return PRODUCT_COLORS[product] ?? ["#0D9488", "#3B82F6", "#8B5CF6", "#F59E0B", "#C0392B", "#EC4899"][i % 6];
}

function StatTile({ label, value, tone = "neutral", info }: { label: string; value: string; tone?: string; info?: string }) {
  const toneCls =
    tone === "accent" ? "text-accent" :
    tone === "success" ? "text-success" :
    tone === "warning" ? "text-warning" :
    tone === "danger" ? "text-danger" :
    tone === "info" ? "text-info" : "text-brand-dark";
  return (
    <div className="rounded-lg border border-border bg-surface/40 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-neutral flex items-center gap-1">
        {label}
        {info && <InfoTip text={info} label={`What is ${label}?`} />}
      </div>
      <div className={`text-lg font-semibold leading-tight tabular-nums ${toneCls}`}>{value}</div>
    </div>
  );
}

// Horizontal 100%-stacked product/SKU mix bar + legend rows.
function ProductMix({ mix, cur }: { mix: ProductMixSlice[]; cur: MoneyCurrency }) {
  return (
    <div>
      <div className="flex h-3 w-full overflow-hidden rounded-full border border-border">
        {mix.map((s, i) => (
          <div
            key={s.product}
            title={`${s.product} · ${fmtPct(s.pct)} · ${fmtMoney(s.spend_usd_month, cur, { compact: true })}`}
            style={{ width: `${s.pct * 100}%`, backgroundColor: colorFor(s.product, i) }}
          />
        ))}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5">
        {mix.map((s, i) => (
          <div key={s.product} className="flex items-center gap-2 text-xs min-w-0">
            <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: colorFor(s.product, i) }} />
            <span className="truncate text-brand-dark">{s.product}</span>
            <span className="ml-auto shrink-0 tabular-nums text-neutral">{fmtPct(s.pct)}</span>
            <span className="w-16 shrink-0 text-right tabular-nums text-neutral">{fmtMoney(s.spend_usd_month, cur, { compact: true })}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Ranked "top by $" list with an inline share bar relative to the leader.
function TopList<T extends SpendByEntity>({
  title,
  items,
  label,
  cur,
  mono = false,
  tip,
}: {
  title: string;
  items: T[];
  label: (item: T) => string;
  cur: MoneyCurrency;
  mono?: boolean;
  tip?: string;
}) {
  const max = Math.max(1, ...items.map((i) => i.spend_usd_month));
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-neutral mb-2 flex items-center gap-1.5">
        {title}
        {tip && <InfoTip text={tip} />}
      </div>
      <div className="flex flex-col gap-1.5">
        {items.map((it, i) => (
          <div key={i} className="flex items-center gap-2 text-xs">
            <div className="flex-1 min-w-0">
              <div className={`truncate ${mono ? "font-mono" : ""} text-brand-dark`}>{label(it)}</div>
              <div className="mt-1 h-1 w-full rounded-full bg-border/60 overflow-hidden">
                <div className="h-full rounded-full bg-accent" style={{ width: `${(it.spend_usd_month / max) * 100}%` }} />
              </div>
            </div>
            <span className="w-14 shrink-0 text-right tabular-nums text-neutral">{fmtMoney(it.spend_usd_month, cur, { compact: true })}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function WorkspaceDetail({ workspaceId }: { workspaceId: string }) {
  const cur = useCurrency();
  const { data, loading, error } = useApi(() => fetchWorkspaceDetail(workspaceId), [workspaceId]);

  if (loading) return <LoadingCard label="Loading workspace detail…" />;
  if (error) return <PageDataError pageId="workspaces" message={error} />;
  if (!data) return null;

  const d: WorkspaceDetailT = data.data;
  const cd = d.cost_drivers;

  return (
    <div className="flex flex-col gap-4">
      {/* Header summary */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-neutral">{d.workspace}</span>
        <StatusPill status={d.health} />
        <Pill className={d.complexity === "Easy" ? "bg-success/15 text-success" : d.complexity === "Hard" ? "bg-danger/15 text-danger" : "bg-info/15 text-info"}>{d.complexity} to optimise</Pill>
      </div>

      {/* Stat tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
        <StatTile label="Spend / mo" value={fmtMoney(d.spend_usd_month, cur, { compact: true })} tone="accent" info="This workspace's estimated monthly spend at list price (DBUs consumed times effective list rate)." />
        <StatTile label="DBUs / mo" value={fmtNum(d.dbus_month, { compact: true })} tone="info" info="Databricks Units consumed per month, the unit of processing you are billed for." />
        <StatTile label="Automated" value={fmtPct(d.automated_pct)} info="Share of spend on automated or optimised compute (serverless, jobs, Predictive Optimization) versus manually managed compute." />
        <StatTile label="Tagged" value={fmtPct(d.tagged_pct)} tone={d.tagged_pct < 0.5 ? "warning" : "neutral"} info="Share of this month's spend carrying cost-attribution tags (custom_tags; blanket keys excluded on the Tags tab don't count). Untagged spend cannot be charged back." />
        <StatTile label="Serverless" value={fmtPct(d.serverless_share)} info="Share of this workspace's spend on serverless SKUs versus classic compute." />
        <StatTile label="Clusters" value={String(d.num_clusters)} info="Number of active all-purpose and job clusters seen in this workspace." />
        <StatTile label="Warehouses" value={String(d.num_warehouses)} info="Number of active Databricks SQL warehouses serving queries in this workspace." />
      </div>

      {/* Best-practice checks — the basis of the Health rating */}
      <div className="rounded-lg border border-border bg-surface/50 p-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-neutral mb-2">
          Best-practice checks (health = worst applicable check)
        </div>
        <div className="flex flex-col gap-1.5">
          {d.checks.map((c) => (
            <div key={c.id} className="flex items-start gap-2 text-xs">
              <span className={`pill shrink-0 ${
                c.status === "pass" ? "bg-success/15 text-success"
                : c.status === "warn" ? "bg-warning/15 text-warning"
                : c.status === "fail" ? "bg-danger/15 text-danger"
                : "bg-border/60 text-neutral"}`}>{c.status}</span>
              <span className="font-medium shrink-0">{c.label}</span>
              <span className="text-neutral">{c.detail}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Product / SKU mix */}
        <div className="rounded-lg border border-border bg-surface/30 p-4">
          <div className="text-sm font-semibold mb-3 flex items-center gap-1.5">
            Product / SKU mix
            <InfoTip text="How this workspace's spend splits across products like DBSQL, Jobs, DLT or Lakeflow, Model Serving, and Apps. Shows which product to target for savings." />
          </div>
          <ProductMix mix={d.product_mix} cur={cur} />
        </div>

        {/* Monthly trend */}
        <div className="rounded-lg border border-border bg-surface/30 p-4">
          <div className="text-sm font-semibold mb-1">Monthly spend</div>
          <WorkspaceTrendChart data={d.monthly_trend} />
        </div>
      </div>

      {/* Top-by-$ breakdowns */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="rounded-lg border border-border bg-surface/30 p-4">
          <TopList title="Top users by $" items={d.top_users} label={(u) => u.user} cur={cur} mono tip="The principals or users driving the most monthly spend in this workspace, ranked by dollars. Useful for targeting the biggest cost owners." />
        </div>
        <div className="rounded-lg border border-border bg-surface/30 p-4">
          <TopList title="Top jobs by $" items={d.top_jobs} label={(j) => j.job} cur={cur} mono />
        </div>
        <div className="rounded-lg border border-border bg-surface/30 p-4">
          <TopList title="Top warehouses by $" items={d.top_warehouses} label={(w) => w.warehouse} cur={cur} mono tip="The SQL warehouses active in this workspace that cost the most per month, ranked by dollars. Idle or oversized warehouses are common savings targets." />
        </div>
      </div>

      {/* Cost-by-driver + SKU breakdown drill-down */}
      {cd && (
        <>
          <div className="flex items-center gap-2 pt-1">
            <span className="text-sm font-semibold flex items-center gap-1.5">
              Cost by cost-driver &amp; SKU
              <InfoTip text="Breaks this workspace's spend down by cost-driver product and by individual billing SKU. Helps pinpoint exactly what to optimize." />
            </span>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <DriverBar drivers={cd.drivers} title="Cost by cost-driver (product)" />
            <DriverTrendChart trend={cd.trend} />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <SkuStackedBar skus={cd.sku_breakdown} title="Cost by SKU (stacked by driver)" />
            <MoMChangeBar mom={cd.mom} />
          </div>
          <DbuBySkuBar dbu={cd.dbu_by_sku} />
          <div>
            <div className="text-xs uppercase tracking-wide text-neutral mb-2 flex items-center gap-1.5">
              SKU-level breakdown (total_cost · % of total)
              <InfoTip text="A SKU is a single priced product and region billing line. Shows each SKU's total cost and share of spend so you can see where money goes." />
            </div>
            <SkuBreakdownTable skus={cd.sku_breakdown} />
          </div>
        </>
      )}

      {/* Genie spend — Code vs Spaces for this workspace */}
      <GenieSpendCard workspace={d.workspace} />
    </div>
  );
}
