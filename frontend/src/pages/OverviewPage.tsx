import { fetchOverview } from "../api/client";
import { useCachedApi } from "../hooks/useCachedApi";
import { useAppStore, useCurrency } from "../store/appStore";
import { KpiCard } from "../components/kpi/KpiCard";
import { KpiRow } from "../components/kpi/KpiRow";
import { SpendSavingsChart } from "../components/charts/SpendSavingsChart";
import { DriverBar, DriverTrendChart, MoMChangeBar } from "../components/charts/CostDriverCharts";
import { PageShell, LoadingCard, PageDataError } from "../components/layout/PageShell";
import { Pill } from "../components/shared/Pill";
import { InfoTip } from "../components/shared/InfoTip";
import { fmtMoney, fmtNum } from "../components/shared/format";
import type { TopOpportunity } from "../types";

const OPP_STYLE: Record<TopOpportunity["type"], string> = {
  query: "bg-insight-rewrite/15 text-insight-rewrite",
  table: "bg-insight-vacuum/15 text-insight-vacuum",
  access: "bg-danger/15 text-danger",
  workspace: "bg-info/15 text-info",
};

export function OverviewPage() {
  const { setActivePage } = useAppStore();
  const cur = useCurrency();
  const { data, loading, error, cache, refresh } = useCachedApi(() => fetchOverview(), []);

  return (
    <PageShell
      title="Overview"
      subtitle="Global cost, spend drivers, and the open best-practice opportunities across the estate"
      cache={cache}
      onRefresh={refresh}
    >
      {loading && <LoadingCard />}
      {error && <PageDataError pageId="overview" message={error} />}
      {data && (
        <>
          <KpiRow cols={4}>
            <KpiCard label="Total spend / mo" value={fmtMoney(data.data.total_spend_usd_month, cur, { compact: true })} tone="accent" hint={cur.code === "USD" ? "list price" : `list price × ${cur.rate} FX`} info="Estimated monthly cost across all workspaces at list price (DBUs, Databricks Units, times the effective price). Your headline cost-control number." />
            <KpiCard label="Total DBUs / mo" value={fmtNum(data.data.total_dbus_month, { compact: true })} tone="info" info="Total Databricks Units consumed per month. A DBU is the unit of processing you are billed for, so it is the volume driver behind spend." />
            <KpiCard label="Need attention" value={String(data.data.num_critical)} tone="warning" hint="critical health" info="Number of workspaces with a critical health status, meaning they most urgently need cost or hygiene attention." />
            <KpiCard
              label="Optimisation complexity"
              value={`${data.data.opt_easy} / ${data.data.opt_medium} / ${data.data.opt_hard}`}
              tone="neutral"
              hint="easy / medium / hard"
              info="How much work optimising each workspace takes, from the measured shares. Easy: at least 60% serverless with almost no interactive classic compute — incremental tuning. Hard: under 30% serverless with a heavy interactive share — structural migration. Medium: in between."
            />
          </KpiRow>

          <SpendSavingsChart data={data.data.trend} />

          {/* Cost by cost-driver (product) + top-5 monthly trend */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <DriverBar drivers={data.data.cost_drivers.drivers} />
            <DriverTrendChart trend={data.data.cost_drivers.trend} />
          </div>

          {/* Driver change vs prior 30 days (%) — spike detection */}
          <MoMChangeBar mom={data.data.cost_drivers.mom} />

          <div className="card">
            <div className="flex items-baseline justify-between mb-3">
              <h3 className="text-sm font-semibold flex items-center gap-1.5">
                Top savings opportunities
                <InfoTip text="The worst open best-practice check per workspace (tagging, serverless, jobs-over-interactive, spend trajectory), biggest spenders first. Workspaces passing every applicable check are not listed." />
              </h3>
              <button
                type="button"
                onClick={() => setActivePage("recommendations")}
                className="text-xs text-accent hover:underline"
              >
                View all in Recommendations →
              </button>
            </div>
            <div className="flex flex-col divide-y divide-border/60">
              {data.data.top_opportunities.length === 0 && (
                <p className="text-xs text-neutral py-2">
                  Every applicable best-practice check passes across the scoped workspaces — no open opportunities.
                </p>
              )}
              {data.data.top_opportunities.map((opp, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setActivePage("recommendations")}
                  className="flex items-center gap-3 py-2.5 text-left w-full hover:bg-surface/50 -mx-2 px-2 rounded transition"
                >
                  <Pill className={`uppercase tracking-wide ${OPP_STYLE[opp.type]}`}>{opp.type}</Pill>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">
                      <span className="text-accent">{opp.insight}</span>
                      <span className="text-neutral mx-1.5">·</span>
                      <span className="font-mono text-xs">{opp.target}</span>
                    </div>
                    <div className="text-xs text-neutral truncate">{opp.detail}</div>
                  </div>
                  <div className="text-right shrink-0">
                    {(opp.est_savings_usd_month ?? 0) > 0 ? (
                      <div className="text-sm font-semibold text-success tabular-nums">
                        {fmtMoney(opp.est_savings_usd_month ?? 0, cur)}/mo
                      </div>
                    ) : (
                      <div className="text-xs text-neutral">—</div>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </PageShell>
  );
}
