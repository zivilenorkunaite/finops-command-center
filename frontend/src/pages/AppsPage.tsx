import { fetchAppsCost } from "../api/client";
import { useCachedApi } from "../hooks/useCachedApi";
import { PageShell, LoadingCard, PageDataError } from "../components/layout/PageShell";
import { DataTable } from "../components/shared/DataTable";
import type { Column } from "../components/shared/DataTable";
import { KpiCard } from "../components/kpi/KpiCard";
import { KpiRow } from "../components/kpi/KpiRow";
import { InfoTip } from "../components/shared/InfoTip";
import { fmtMoney, fmtNum, fmtPct } from "../components/shared/format";
import { useCurrency } from "../store/appStore";
import { OboAttributionCard } from "../components/apps/OboAttributionCard";
import type { AppCostRow } from "../types";

// Apps $ — Databricks Apps compute cost + runtime (billing), the declared
// resource assets with attributable cost, and best-practice flags grounded
// in docs.databricks.com → Databricks Apps → Best practices.

const FLAG_HELP: Record<string, string> = {
  "always-on":
    "This app's compute ran ≥95% of the month so far. App compute bills every hour it is RUNNING, visited or not — stop apps that are not in active use.",
  "stale & running":
    "Running continuously but not updated in over 30 days — a strong candidate to stop or delete if nobody uses it.",
  "no resource bindings":
    "The app declares no managed resources (warehouse, secret, endpoint…). If it reaches data or services anyway, credentials may be hard-coded — prefer managed resource bindings.",
};

const FLAG_STYLE: Record<string, string> = {
  "always-on": "bg-warning/15 text-warning",
  "stale & running": "bg-danger/15 text-danger",
  "no audit history (created >1y ago?)": "bg-border/60 text-neutral",
  "no resource bindings": "bg-insight-convert/15 text-insight-convert",
};

function StatePill({ state }: { state: string }) {
  const cls =
    state === "RUNNING" ? "bg-success/15 text-success"
    : state === "STOPPED" ? "bg-border/60 text-neutral"
    : state === "DELETED" ? "bg-danger/15 text-danger"
    : "bg-info/15 text-info";
  return <span className={`pill ${cls}`}>{state}</span>;
}

// Expanded row: where this app's money actually goes — its own compute, the
// warehouse compute it drives (on-behalf-of or as its service principal),
// its genie spaces, full-cost assets, and the shared resources it declares
// (totals, deliberately not attributed).
function AppCostBreakdown({ app, cur }: { app: AppCostRow; cur: ReturnType<typeof useCurrency> }) {
  const rows: { label: string; value: string; note: string; strong?: boolean }[] = [
    {
      label: "App compute",
      value: fmtMoney(app.cost_usd, cur),
      note: "The app container itself (APPS billing rows) — bills every hour the app runs.",
    },
    {
      label: "Warehouse compute driven by the app (callers)",
      value: app.obo ? fmtMoney(app.obo.usd, cur) : "—",
      note: app.obo
        ? `${fmtNum(app.obo.statements)} statements by ${fmtNum(app.obo.users)} user(s) on ${app.obo.warehouses.join(", ")} — hour-matched: each billed warehouse-hour is split by that hour's task-time; hours without app statements cost the app nothing.`
        : "No caller statements matched this app's name this month — if the app queries warehouses, name its identity in the card below (on-behalf-of or service principal).",
    },
    {
      label: "Genie-space warehouse compute",
      value: app.assets_usd > 0 ? fmtMoney(app.assets_usd, cur) : "—",
      note: "Statements attributed to this app's genie spaces via query_source.genie_space_id — hour-matched like the caller attribution.",
    },
    ...app.assets
      .filter((x) => x.attribution === "full" && x.usd != null)
      .map((x) => ({
        label: `${x.type} ${x.label} *`,
        value: fmtMoney(x.usd ?? 0, cur),
        note: "* full resource cost — declared only by this app; overstates if the resource is also used from outside apps.",
      })),
    {
      label: "Total linked (attributed)",
      value: fmtMoney(app.linked_usd ?? 0, cur),
      note: "Caller-attributed warehouse compute + genie + full-cost assets — spend caused by this app on top of its own compute.",
      strong: true,
    },
  ];
  const shared = app.assets.filter((x) => x.attribution === "shared");
  const unattributable = app.assets.filter((x) => !x.attribution);
  return (
    <div className="flex flex-col gap-3 text-sm max-w-3xl">
      <div className="rounded-lg border border-border bg-surface/50 p-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-neutral mb-2">Cost breakdown (month-to-date)</div>
        <div className="flex flex-col gap-2">
          {rows.map((r) => (
            <div key={r.label} className="flex items-start gap-3 text-xs">
              <span className={`w-72 shrink-0 ${r.strong ? "font-semibold" : ""}`}>{r.label}</span>
              <span className={`w-20 shrink-0 text-right tabular-nums ${r.strong ? "font-semibold" : ""}`}>{r.value}</span>
              <span className="text-neutral">{r.note}</span>
            </div>
          ))}
        </div>
      </div>
      {(shared.length > 0 || unattributable.length > 0) && (
        <div className="text-xs text-neutral">
          <span className="font-medium text-brand-dark">Declared shared resources: </span>
          {shared.map((x) => `${x.type} ${x.label} (${x.usd != null ? fmtMoney(x.usd, cur) : "$?"}/mo total)`).join(", ")}
          {shared.length > 0 && unattributable.length > 0 ? "; " : ""}
          {unattributable.map((x) => `${x.type} ${x.label} (not attributable from billing)`).join(", ")}
          {" — "}totals of resources other workloads also use; the caller figure above is this app's measured slice of the shared warehouses, so these totals are not added again.
        </div>
      )}
    </div>
  );
}

export function AppsPage() {
  const cur = useCurrency();
  const { data, loading, error, cache, refresh } = useCachedApi(() => fetchAppsCost(), []);
  const ac = data?.data;

  const columns: Column<AppCostRow>[] = [
    {
      key: "name",
      header: "App",
      sortValue: (a) => a.name,
      render: (a) => (
        <div className="min-w-0 max-w-[240px]">
          {a.url ? (
            <a href={a.url} target="_blank" rel="noreferrer" className="text-xs font-medium text-accent hover:underline truncate inline-block max-w-full">{a.name}</a>
          ) : (
            <span className="text-xs font-medium truncate inline-block max-w-full">{a.name}</span>
          )}
          <div className="text-[10px] text-neutral truncate">{a.creator || "—"}</div>
        </div>
      ),
    },
    {
      key: "state",
      header: (
        <span className="inline-flex items-center gap-1">State<InfoTip text="Derived from system tables: DELETED / STOPPED from the last lifecycle audit event, RUNNING when compute billed within the last ~8 hours (billing lags), IDLE otherwise." /></span>
      ),
      align: "center", sortValue: (a) => a.state, render: (a) => <StatePill state={a.state} />,
    },
    {
      key: "runtime",
      header: (
        <span className="inline-flex items-center gap-1">Runtime<InfoTip text="Total hours this app's compute ran month-to-date (each APPS billing row covers about one hour), with the share of the month it was up." /></span>
      ),
      align: "right",
      sortValue: (a) => a.runtime_h,
      render: (a) => (
        <span className="tabular-nums text-neutral">{fmtNum(a.runtime_h)} h · {fmtPct(a.uptime_pct)}</span>
      ),
    },
    {
      key: "assets",
      header: (
        <span className="inline-flex items-center gap-1">Related assets<InfoTip text="Every resource the app declares, from its last create/update audit event: warehouses, serving endpoints, genie spaces, databases, secrets, tables…" /></span>
      ),
      sortValue: (a) => a.assets.length,
      render: (a) => (
        <span className="flex flex-wrap gap-1 max-w-[300px]">
          {a.assets.length === 0 && <span className="text-xs text-neutral">—</span>}
          {a.assets.map((x, i) => (
            <span
              key={i}
              className={`pill ${x.attribution === "app" ? "bg-success/10 text-success" : x.attribution === "full" ? "bg-warning/10 text-warning" : "bg-border/40 text-neutral"}`}
              title={
                x.usd != null && x.attribution === "app"
                  ? `${x.type} · ${fmtMoney(x.usd, cur)}/mo attributed to this app`
                  : x.usd != null && x.attribution === "full"
                  ? `${x.type} · ${fmtMoney(x.usd, cur)}/mo FULL resource cost carried by this app — overstates if the resource is shared`
                  : x.usd != null
                  ? `${x.type} · ${fmtMoney(x.usd, cur)}/mo resource TOTAL — shared, not separable per app`
                  : `${x.type} · $ not attributable from billing`
              }
            >
              {x.type}: {x.label.length > 24 ? x.label.slice(0, 22) + "…" : x.label}{x.attribution === "full" ? " *" : ""}
            </span>
          ))}
        </span>
      ),
    },
    {
      key: "cost",
      header: (
        <span className="inline-flex items-center gap-1">App $ / mo<InfoTip text="Month-to-date compute cost of the app itself at list price (APPS billing rows)." /></span>
      ),
      align: "right",
      sortValue: (a) => a.cost_usd,
      render: (a) => <span className="tabular-nums font-medium">{fmtMoney(a.cost_usd, cur)}</span>,
    },
    {
      key: "linked_usd",
      header: (
        <span className="inline-flex items-center gap-1">Linked $ / mo (attributed)<InfoTip text="Spend genuinely caused by THIS app beyond its own compute: hour-matched warehouse compute driven by the app (on-behalf-of or service principal) + its genie spaces' warehouse compute + full-cost assets (Lakebase, declared jobs — asterisked, overstate when shared). Expand the row for the breakdown. Shared warehouse totals are NOT summed here — the caller figure already is this app's slice of them." /></span>
      ),
      align: "right",
      sortValue: (a) => a.linked_usd ?? 0,
      render: (a) => <span className="tabular-nums font-medium">{(a.linked_usd ?? 0) > 0 ? fmtMoney(a.linked_usd ?? 0, cur) : "—"}</span>,
    },
    {
      key: "flags",
      header: (
        <span className="inline-flex items-center gap-1">Best practice<InfoTip text="Deterministic checks from the Databricks Apps best-practices guidance — hover each flag for what to do." /></span>
      ),
      sortValue: (a) => a.flags.length,
      render: (a) => (
        <span className="flex flex-wrap gap-1 max-w-[220px]">
          {a.flags.length === 0 && <span className="pill bg-success/15 text-success">ok</span>}
          {a.flags.map((f) => (
            <span key={f} className={`pill ${FLAG_STYLE[f] ?? "bg-border/60 text-neutral"}`} title={FLAG_HELP[f] ?? f}>{f}</span>
          ))}
        </span>
      ),
    },
    { key: "updated", header: (
      <span className="inline-flex items-center gap-1">Updated<InfoTip text="Last deploy or spec change seen in the audit log (deployApp / createUpdate / updateApp events). Audit ingestion lags by up to a few hours, so a fresh deploy can take a while to show." /></span>
    ), align: "right", sortValue: (a) => a.updated, render: (a) => <span className="tabular-nums text-xs text-neutral">{a.updated || "—"}</span> },
  ];

  return (
    <PageShell
      title="Apps spend"
      subtitle="Databricks Apps — compute cost and runtime per app, the assets each app declares (with attributable cost), and best-practice flags. All from system tables; figures are list price, month-to-date."
      cache={cache}
      onRefresh={refresh}
    >
      {loading && !ac && <LoadingCard label="Reading APPS billing + audit events…" />}
      {error && <PageDataError pageId="apps" message={error} />}
      {ac && (
        <>
          <KpiRow cols={5}>
            <KpiCard label="Apps $ / mo" value={fmtMoney(ac.summary.total_usd, cur, { compact: true })} tone="accent" hint="app compute, list price" info="Month-to-date compute cost of all apps (APPS billing rows). App compute bills every hour an app is running, visited or not." />
            <KpiCard label="Apps" value={String(ac.summary.num_apps)} tone="neutral" hint={`${ac.summary.num_running} running`} info="Every app seen in APPS billing rows or apps audit events this month, within the workspace scope." />
            <KpiCard label="Total runtime / mo" value={`${fmtNum(ac.summary.runtime_h)} h`} tone="info" info="Summed hours of app compute across all apps this month — the direct driver of app cost." />
            <KpiCard label="Linked $ / mo (attributed)" value={fmtMoney(ac.summary.linked_usd, cur, { compact: true })} tone="warning" hint={`callers ${fmtMoney(ac.summary.obo_usd, cur, { compact: true })} + genie ${fmtMoney(ac.summary.assets_usd, cur, { compact: true })}`} info="Spend genuinely caused by apps beyond their own compute: hour-matched caller warehouse compute (on-behalf-of + service principal, incl. identities not yet named) + genie-space compute + full-cost assets (Lakebase instances and declared jobs, asterisked). Shared totals are not summed — the caller figure already is the apps' slice of them." />
            <KpiCard label="Best-practice flags" value={String(ac.apps.reduce((n, a) => n + a.flags.length, 0))} tone="danger" hint="hover flags in the table" info="Total open best-practice findings across apps: always-on compute, stale apps still running, missing budget policies, missing resource bindings." />
          </KpiRow>

          <DataTable
            columns={columns}
            rows={ac.apps}
            rowKey={(a) => a.name}
            initialSort={{ key: "cost", dir: "desc" }}
            emptyMessage="No apps found."
            renderExpanded={(a) => <AppCostBreakdown app={a} cur={cur} />}
          />

          <OboAttributionCard
            rows={ac.obo.rows}
            totalUsd={ac.obo.total_usd}
            error={ac.obo.error}
            cur={cur}
            onSaved={refresh}
          />

          <div className="card flex flex-col gap-2 py-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-neutral">How to read this</div>
            <ul className="flex flex-col gap-1 text-[11px] text-neutral">
              {ac.caveats.map((c, i) => (
                <li key={i} className="flex gap-1.5">
                  <span className="text-warning shrink-0" aria-hidden>·</span>
                  <span>{c}</span>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </PageShell>
  );
}
