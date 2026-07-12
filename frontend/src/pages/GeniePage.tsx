import { useMemo, useState } from "react";
import { fetchGenieCost } from "../api/client";
import { useCachedApi } from "../hooks/useCachedApi";
import { PageShell, LoadingCard, PageDataError } from "../components/layout/PageShell";
import { DataTable } from "../components/shared/DataTable";
import type { Column } from "../components/shared/DataTable";
import { FilterBar, Dropdown, SearchBox } from "../components/shared/FilterBar";
import { KpiCard } from "../components/kpi/KpiCard";
import { KpiRow } from "../components/kpi/KpiRow";
import { InfoTip } from "../components/shared/InfoTip";
import { surfaceStyle, surfaceHelp } from "../components/genie/GenieSpendCard";
import { fmtMoney, fmtNum, fmtPct } from "../components/shared/format";
import { useCurrency } from "../store/appStore";
import type { GenieCostRow, GenieSpaceCost } from "../types";

// Genie $ tab — Genie cost by surface (as billed: Genie Code / Genie One /
// Genie Agents), per workspace and per user, from system.billing.usage
// (billing_origin_product = 'GENIE'), plus per-space warehouse-compute
// attribution from query history. Deterministic billing attribution (calls
// no model). Dollar figures are LIST price.

export function GeniePage() {
  const cur = useCurrency();
  const [workspace, setWorkspace] = useState("all");
  const [search, setSearch] = useState("");

  // One fetch of the full estate; the workspace/user filters are applied
  // client-side.
  const { data, loading, error, cache, refresh } = useCachedApi(() => fetchGenieCost({}), []);
  const gc = data?.data;

  const wsOptions = useMemo(
    () => [
      { value: "all", label: "All workspaces" },
      ...(gc?.by_workspace ?? []).map((w) => ({ value: w.workspace, label: w.workspace })),
    ],
    [gc],
  );

  const rows = useMemo(() => {
    let r: GenieCostRow[] = gc?.breakdown ?? [];
    if (workspace !== "all") r = r.filter((x) => x.workspace === workspace);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      r = r.filter((x) => x.user_identity.toLowerCase().includes(q) || x.workspace.toLowerCase().includes(q));
    }
    return r;
  }, [gc, workspace, search]);

  // KPIs + per-surface + per-user roll-ups recomputed from the filtered rows.
  const roll = useMemo(() => {
    const list = rows.reduce((a, r) => a + r.total_list_cost_usd, 0);
    const dbus = rows.reduce((a, r) => a + r.total_dbus, 0);
    const users = new Set(rows.map((r) => r.user_identity));
    const workspaces = new Set(rows.map((r) => r.workspace));
    const bySurface = new Map<string, { surface: string; label: string; list: number; dbus: number }>();
    for (const r of rows) {
      const s = bySurface.get(r.surface) ?? { surface: r.surface, label: r.label, list: 0, dbus: 0 };
      s.list += r.total_list_cost_usd;
      s.dbus += r.total_dbus;
      bySurface.set(r.surface, s);
    }
    const surfaces = [...bySurface.values()].sort((a, b) => b.list - a.list);
    const byUser = new Map<string, { user: string; list: number; dbus: number; ws: Set<string>; top: string; topDbus: number }>();
    for (const r of rows) {
      const u = byUser.get(r.user_identity) ?? { user: r.user_identity, list: 0, dbus: 0, ws: new Set(), top: r.label, topDbus: 0 };
      u.list += r.total_list_cost_usd;
      u.dbus += r.total_dbus;
      u.ws.add(r.workspace);
      if (r.total_dbus > u.topDbus) { u.top = r.label; u.topDbus = r.total_dbus; }
      byUser.set(r.user_identity, u);
    }
    const usersRanked = [...byUser.values()].sort((a, b) => b.list - a.list);
    return { list, dbus, users: users.size, workspaces: workspaces.size, surfaces, usersRanked };
  }, [rows]);

  // Cap the two big tables so a real workspace (thousands of users) stays fast.
  const USER_CAP = 50;
  const DETAIL_CAP = 150;
  const topUsers = roll.usersRanked.slice(0, USER_CAP);
  const detailRows = [...rows].sort((a, b) => b.total_list_cost_usd - a.total_list_cost_usd).slice(0, DETAIL_CAP);

  const maxSurface = Math.max(1, ...roll.surfaces.map((s) => s.list));

  const userColumns: Column<(typeof roll.usersRanked)[number]>[] = [
    {
      key: "user",
      header: "User",
      sortValue: (u) => u.user,
      render: (u) => <span className="font-mono text-xs text-brand-dark truncate max-w-[220px] inline-block">{u.user}</span>,
    },
    {
      key: "top",
      header: (
        <span className="inline-flex items-center gap-1">Top surface<InfoTip text="The Genie surface this user spends the most DBUs on: Genie Code, Genie One, or Genie Agents (as billed)." /></span>
      ),
      sortValue: (u) => u.top,
      render: (u) => {
        const surface = rows.find((r) => r.label === u.top)?.surface ?? "UNKNOWN";
        return <span className={`pill ${surfaceStyle(surface).pill}`}>{u.top}</span>;
      },
    },
    { key: "ws", header: "Workspaces", align: "center", sortValue: (u) => u.ws.size, render: (u) => <span className="tabular-nums">{u.ws.size}</span> },
    { key: "dbus", header: "DBUs", align: "right", sortValue: (u) => u.dbus, render: (u) => <span className="tabular-nums text-neutral">{fmtNum(u.dbus)}</span> },
    {
      key: "list",
      header: (
        <span className="inline-flex items-center gap-1">List $<InfoTip text="Genie cost at published list price for this user across all surfaces (DBUs times effective list rate)." /></span>
      ),
      align: "right",
      sortValue: (u) => u.list,
      render: (u) => <span className="tabular-nums">{fmtMoney(u.list, cur)}</span>,
    },
  ];

  const detailColumns: Column<GenieCostRow>[] = [
    { key: "workspace", header: "Workspace", sortValue: (r) => r.workspace, render: (r) => <span className="font-mono text-xs text-neutral truncate max-w-[170px] inline-block">{r.workspace}</span> },
    { key: "user", header: "User", sortValue: (r) => r.user_identity, render: (r) => <span className="font-mono text-xs text-brand-dark truncate max-w-[190px] inline-block">{r.user_identity}</span> },
    {
      key: "surface",
      header: (
        <span className="inline-flex items-center gap-1">Surface<InfoTip text="Which Genie surface generated the usage, as billed: Genie Code (editor/notebook), Genie One (conversational), or Genie Agents (agent surface)." /></span>
      ),
      sortValue: (r) => r.label,
      render: (r) => <span className={`pill ${surfaceStyle(r.surface).pill}`}>{r.label}</span>,
    },
    { key: "dbus", header: "DBUs", align: "right", sortValue: (r) => r.total_dbus, render: (r) => <span className="tabular-nums text-neutral">{fmtNum(r.total_dbus)}</span> },
    { key: "list", header: "List $", align: "right", sortValue: (r) => r.total_list_cost_usd, render: (r) => <span className="tabular-nums">{fmtMoney(r.total_list_cost_usd, cur)}</span> },
  ];

  const spaceColumns: Column<GenieSpaceCost>[] = [
    {
      key: "space",
      header: "Genie space",
      sortValue: (s) => s.title ?? s.space_id,
      render: (s) => (
        <div className="min-w-0">
          <div className="text-xs font-medium truncate">{s.title ?? s.space_id}</div>
          {s.title && <div className="text-[10px] font-mono text-neutral truncate">{s.space_id}</div>}
        </div>
      ),
    },
    { key: "queries", header: "Queries (mo)", align: "right", sortValue: (s) => s.queries, render: (s) => <span className="tabular-nums">{fmtNum(s.queries)}</span> },
    { key: "users", header: "Users", align: "center", sortValue: (s) => s.users, render: (s) => <span className="tabular-nums text-neutral">{s.users}</span> },
    { key: "task", header: "Compute time", align: "right", sortValue: (s) => s.task_s, render: (s) => <span className="tabular-nums text-neutral">{fmtNum(s.task_s)} s</span> },
    {
      key: "usd",
      header: (
        <span className="inline-flex items-center gap-1">Est. warehouse $ / mo<InfoTip text="An estimate of the SQL compute this space's generated queries consumed, hour-matched: each billed warehouse-hour is split by that hour's task-time shares (denominator floored at one compute-hour), so hours where the space ran nothing cost it nothing. This is warehouse spend, on top of (not part of) the Genie DBUs above." /></span>
      ),
      align: "right",
      sortValue: (s) => s.est_warehouse_usd,
      render: (s) => <span className="tabular-nums font-medium">{fmtMoney(s.est_warehouse_usd, cur)}</span>,
    },
  ];

  return (
    <PageShell
      title="Genie spend"
      subtitle="Genie cost by surface (as billed: Genie Code / Genie One / Genie Agents), per workspace and per user — from system.billing.usage. Figures are list price."
      cache={cache}
      onRefresh={refresh}
    >
      {loading && !gc && <LoadingCard />}
      {error && <PageDataError pageId="genie" message={error} />}
      {gc && (
        <>
          <FilterBar>
            <Dropdown label="Workspace" value={workspace} onChange={setWorkspace} options={wsOptions} />
            <SearchBox value={search} onChange={setSearch} placeholder="Filter by user or workspace…" />
          </FilterBar>

          <KpiRow cols={4}>
            <KpiCard label="Genie $ / mo" value={fmtMoney(roll.list, cur, { compact: true })} tone="accent"
              hint={gc.total_platform_spend_usd_month ? `${fmtPct(roll.list / gc.total_platform_spend_usd_month, 1)} of total spend` : "list price"}
              info="Total Genie cost this month at published list price. The hint shows it as a share of total platform spend, for context — Genie is typically a small slice." />
            <KpiCard label="Genie users" value={String(roll.users)} tone="info" info="Distinct identified users (identity_metadata.run_as) with Genie usage in the selected scope this month." />
            <KpiCard label="Workspaces" value={String(roll.workspaces)} info="Number of workspaces with Genie usage in the selected scope." />
            <KpiCard label="Surfaces" value={String(roll.surfaces.length)} info="Distinct Genie surfaces in use this month, straight from usage_metadata.genie.surface." />
          </KpiRow>

          {/* Spend by surface */}
          <div className="card flex flex-col gap-3">
            <div className="text-sm font-semibold flex items-center gap-1.5">
              Spend by surface
              <InfoTip text="Genie spend split by the surface that generated it (usage_metadata.genie.surface, shown as billed). The enum is open — the app labels whatever values appear." />
            </div>
            <div className="flex flex-col gap-2.5">
              {roll.surfaces.map((s) => (
                <div key={s.surface} className="flex flex-col gap-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="flex items-center gap-1.5">
                      <span className={`h-2.5 w-2.5 rounded-sm ${surfaceStyle(s.surface).dot}`} />
                      {s.label}
                      <InfoTip text={surfaceHelp(s.surface)} label={`What is ${s.label}?`} />
                    </span>
                    <span className="tabular-nums text-neutral">
                      {fmtMoney(s.list, cur, { compact: true })} · {fmtNum(s.dbus)} DBUs · {fmtPct(s.list / (roll.list || 1), 1)}
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-border/60 overflow-hidden">
                    <div className={`h-full ${surfaceStyle(s.surface).bar}`} style={{ width: `${(s.list / maxSurface) * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Cost by Genie space (warehouse compute attribution) */}
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold flex items-center gap-1.5">
              Cost by Genie space — warehouse compute
              <InfoTip text="Genie DBUs cannot be split by space: billing carries no space id (only surface, channel and agent id). What CAN be measured: every SQL statement a space generates carries query_source.genie_space_id in system.query.history, so each space is charged its task-time share of the warehouse's billed month-to-date cost. Spaces the viewer cannot open show their id instead of a title." />
              {gc.by_space.length > 0 && (
                <span className="text-xs font-normal text-neutral">top {gc.by_space.length} by est. $</span>
              )}
            </h3>
            {gc.by_space.length === 0 ? (
              <div className="card py-4 text-xs text-neutral">
                No Genie-generated warehouse queries this month (query_source.genie_space_id in system.query.history).
              </div>
            ) : (
              <DataTable columns={spaceColumns} rows={gc.by_space} rowKey={(s) => s.space_id} initialSort={{ key: "usd", dir: "desc" }} emptyMessage="No Genie-generated queries this month." />
            )}
            <p className="text-[11px] text-neutral">
              Estimated SQL-warehouse compute consumed by each space's generated queries — separate from,
              and additional to, the Genie DBU spend above. Genie DBUs themselves carry no space id in billing.
            </p>
          </div>

          {/* Top Genie users */}
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold flex items-center gap-1.5">
              Top Genie users
              <InfoTip text="Users ranked by Genie list cost, with their dominant surface and how many workspaces they use Genie in." />
              {roll.usersRanked.length > USER_CAP && (
                <span className="text-xs font-normal text-neutral">top {USER_CAP} of {roll.usersRanked.length}</span>
              )}
            </h3>
            <DataTable columns={userColumns} rows={topUsers} rowKey={(u) => u.user} initialSort={{ key: "list", dir: "desc" }} emptyMessage="No Genie usage for this scope." />
          </div>

          {/* Per user x workspace x surface detail */}
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold flex items-center gap-1.5">
              Per user · workspace · surface
              <InfoTip text="The ground-truth Genie usage rows: one line per user, workspace and surface, with DBUs and list $." />
              {rows.length > DETAIL_CAP && (
                <span className="text-xs font-normal text-neutral">top {DETAIL_CAP} of {rows.length} by $</span>
              )}
            </h3>
            <DataTable columns={detailColumns} rows={detailRows} rowKey={(r) => `${r.workspace}|${r.user_identity}|${r.surface}`} initialSort={{ key: "list", dir: "desc" }} emptyMessage="No Genie usage for this scope." />
          </div>

          {/* Honesty caveats */}
          <div className="card flex flex-col gap-2 py-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-neutral">How to read this</div>
            <ul className="flex flex-col gap-1 text-[11px] text-neutral">
              {gc.caveats.map((c, i) => (
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
