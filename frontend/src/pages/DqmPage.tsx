import { useState } from "react";
import { fetchDqm } from "../api/client";
import { useCachedApi } from "../hooks/useCachedApi";
import { PageShell, LoadingCard, PageDataError } from "../components/layout/PageShell";
import { DataTable } from "../components/shared/DataTable";
import type { Column } from "../components/shared/DataTable";
import { FilterBar, Dropdown, SearchBox } from "../components/shared/FilterBar";
import { KpiCard } from "../components/kpi/KpiCard";
import { KpiRow } from "../components/kpi/KpiRow";
import { Pill } from "../components/shared/Pill";
import { InfoTip } from "../components/shared/InfoTip";
import { fmtMoney, fmtNum } from "../components/shared/format";
import { useCurrency } from "../store/appStore";
import type { DqmMonitor } from "../types";

// Data Quality tab — rendered + routed ONLY when features.dqm is on.
// Monitors are DISCOVERED from their Lakehouse-Monitoring output tables
// (*_profile_metrics / *_drift_metrics visible to the viewer); monitoring
// spend comes from billing; quality statuses appear only when the viewer may
// read system.data_quality_monitoring.table_results (optional grant).

const QUALITY_OPTIONS = [
  { value: "all", label: "All quality" },
  { value: "Good", label: "Good" },
  { value: "Warning", label: "Warning" },
  { value: "Critical", label: "Critical" },
];

const FRESHNESS_OPTIONS = [
  { value: "all", label: "All freshness" },
  { value: "Fresh", label: "Fresh" },
  { value: "Stale", label: "Stale" },
];

const QUALITY_STYLE: Record<string, string> = {
  Good: "bg-success/15 text-success",
  Warning: "bg-warning/15 text-warning",
  Critical: "bg-danger/15 text-danger",
};

function fmtRefresh(hours: number | null): string {
  if (hours == null) return "—";
  if (hours < 1) return "<1h ago";
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function DqmPage() {
  const cur = useCurrency();
  const [quality, setQuality] = useState("all");
  const [freshness, setFreshness] = useState("all");
  const [search, setSearch] = useState("");

  const { data, loading, error, cache, refresh } = useCachedApi(
    () => fetchDqm({ quality, freshness, search }),
    [quality, freshness, search],
  );
  const rows = data?.data ?? [];
  const s = data?.summary;
  const resultsAvailable = s?.results_available ?? false;

  const columns: Column<DqmMonitor>[] = [
    {
      key: "fqn",
      header: "Monitored table",
      sortValue: (r) => r.fqn,
      render: (r) => <span className="text-xs font-mono">{r.fqn}</span>,
    },
    {
      key: "outputs",
      header: (
        <span className="inline-flex items-center gap-1">
          Outputs
          <InfoTip text="Which Lakehouse-Monitoring output tables exist for this monitor: profile metrics (nulls, counts, distributions) and drift metrics (distribution shift between windows)." />
        </span>
      ),
      align: "center",
      sortValue: (r) => (r.has_profile ? 1 : 0) + (r.has_drift ? 1 : 0),
      render: (r) => (
        <span className="inline-flex gap-1">
          {r.has_profile && <Pill className="bg-info/15 text-info">profile</Pill>}
          {r.has_drift && <Pill className="bg-info/15 text-info">drift</Pill>}
          {!r.has_profile && !r.has_drift && <span className="text-neutral text-xs">—</span>}
        </span>
      ),
    },
    {
      key: "refresh",
      header: (
        <span className="inline-flex items-center gap-1">
          Last refresh
          <InfoTip text="When the monitor's output table last changed (information_schema.last_altered) — how recently the monitor actually produced metrics." />
        </span>
      ),
      align: "right",
      sortValue: (r) => r.last_refresh_hours ?? 999999,
      render: (r) => <span className="tabular-nums text-xs text-neutral">{fmtRefresh(r.last_refresh_hours)}</span>,
    },
    {
      key: "freshness",
      header: "Freshness",
      align: "center",
      sortValue: (r) => (r.freshness === "Stale" ? 0 : r.freshness === "Fresh" ? 1 : 2),
      render: (r) => (
        <Pill className={r.freshness === "Fresh" ? "bg-success/15 text-success" : r.freshness === "Stale" ? "bg-warning/15 text-warning" : "bg-border/60 text-neutral"}>
          {r.freshness}
        </Pill>
      ),
    },
    {
      key: "quality",
      header: (
        <span className="inline-flex items-center gap-1">
          Quality
          <InfoTip text={resultsAvailable
            ? "Latest status from system.data_quality_monitoring.table_results."
            : "Needs SELECT on system.data_quality_monitoring.table_results (account-admin grant) — not held by your identity, so no status is shown."} />
        </span>
      ),
      align: "center",
      sortValue: (r) => r.quality_status ?? "",
      render: (r) =>
        r.quality_status ? (
          <Pill className={QUALITY_STYLE[r.quality_status] ?? "bg-border/60 text-neutral"}>{r.quality_status}</Pill>
        ) : (
          <span className="text-neutral text-xs" title="Quality statuses need the optional system-table grant.">—</span>
        ),
    },
    {
      key: "owner",
      header: "Owner",
      sortValue: (r) => r.owner,
      render: (r) => <span className="text-xs font-mono text-neutral truncate max-w-[200px] inline-block">{r.owner || "—"}</span>,
    },
  ];

  return (
    <PageShell
      title="Data Quality"
      subtitle="Lakehouse Monitoring — monitors discovered from their output tables, refresh freshness, and the DATA_QUALITY_MONITORING spend"
      cache={cache}
      onRefresh={refresh}
    >
      {loading && <LoadingCard label="Discovering monitors (information_schema + billing)…" />}
      {error && <PageDataError pageId="dqm" message={error} />}
      {data && s && (
        <>
          <KpiRow cols={4}>
            <KpiCard
              label="Monitors"
              value={fmtNum(s.num_monitors)}
              tone="neutral"
              hint="discovered from output tables"
              info="Monitored tables discovered from their *_profile_metrics / *_drift_metrics output tables — the ones your permissions let you see."
            />
            <KpiCard
              label="Fresh / Stale"
              value={`${s.num_fresh} / ${s.num_stale}`}
              tone={s.num_stale > 0 ? "warning" : "success"}
              hint="output updated within 24h"
              info="Fresh = the monitor's output table changed in the last 24 hours; Stale = it hasn't, so the monitor isn't producing recent metrics."
            />
            <KpiCard
              label="DQM cost / mo"
              value={fmtMoney(s.dqm_cost_usd_month, cur, { compact: true })}
              tone="accent"
              hint={`${fmtNum(s.dqm_dbus_month)} DBUs`}
              info="Month-to-date DATA_QUALITY_MONITORING billing at list price across the scoped workspaces."
            />
            <KpiCard
              label="Quality signal"
              value={resultsAvailable ? `${s.num_critical} critical / ${s.num_warning} warn` : "not granted"}
              tone={resultsAvailable ? (s.num_critical ? "danger" : "success") : "neutral"}
              hint={resultsAvailable ? "from table_results" : "optional system table"}
              info={resultsAvailable
                ? "Latest per-table statuses from system.data_quality_monitoring.table_results."
                : "Quality statuses need SELECT on system.data_quality_monitoring.table_results — an account-admin grant. Everything else on this page works without it."}
            />
          </KpiRow>

          {!resultsAvailable && (
            <div className="card border-l-4 border-l-info py-2.5">
              <p className="text-xs text-neutral">
                Quality statuses are absent: your identity can't read{" "}
                <code className="font-mono">system.data_quality_monitoring.table_results</code> (an
                account-admin grant). Monitors, freshness and spend on this page come from tables you can
                already see.
              </p>
            </div>
          )}

          <FilterBar>
            <Dropdown label="Quality" value={quality} onChange={setQuality} options={QUALITY_OPTIONS} />
            <Dropdown label="Freshness" value={freshness} onChange={setFreshness} options={FRESHNESS_OPTIONS} />
            <SearchBox value={search} onChange={setSearch} placeholder="Search table or owner…" />
          </FilterBar>

          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(r) => r.fqn}
            initialSort={{ key: "refresh", dir: "asc" }}
            emptyMessage="No monitors match — or no Lakehouse-Monitoring output tables are visible to you."
          />

          {(data.by_workspace?.length ?? 0) > 0 && (
            <div className="card max-w-2xl flex flex-col gap-2">
              <h3 className="text-sm font-semibold flex items-center gap-1.5">
                Monitoring spend by workspace
                <InfoTip text="DATA_QUALITY_MONITORING billing rows grouped by workspace, month-to-date at list price." />
              </h3>
              <div className="flex flex-col gap-1.5">
                {data.by_workspace.map((w) => (
                  <div key={w.workspace} className="flex items-center gap-2 text-xs">
                    <span className="font-mono text-neutral">{w.workspace}</span>
                    <span className="ml-auto tabular-nums">{fmtMoney(w.cost_usd_month, cur, { compact: true })}</span>
                    <span className="w-20 text-right tabular-nums text-neutral">{fmtNum(w.dbus_month)} DBUs</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {data.caveat && <p className="text-[11px] text-neutral">{data.caveat}</p>}
        </>
      )}
    </PageShell>
  );
}
