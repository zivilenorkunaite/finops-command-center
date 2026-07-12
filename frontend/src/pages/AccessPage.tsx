import { useMemo, useState } from "react";
import { fetchGrants } from "../api/client";
import { useCachedApi } from "../hooks/useCachedApi";
import { PageShell, LoadingCard, PageDataError } from "../components/layout/PageShell";
import { DataTable } from "../components/shared/DataTable";
import type { Column } from "../components/shared/DataTable";
import { KpiCard } from "../components/kpi/KpiCard";
import { KpiRow } from "../components/kpi/KpiRow";
import { InfoTip } from "../components/shared/InfoTip";
import { SearchBox } from "../components/shared/FilterBar";
import type { Grant } from "../types";

// Access — the DIRECT Unity Catalog grant graph, aggregated two ways:
// by object (catalog -> who can reach it) and by principal (identity -> what
// they can reach). Concerning grants (rules documented on the Configuration page)
// are marked inline and float to the top. All aggregation is client-side
// over the direct-grants list — inherited rows are excluded at the source,
// so one catalog grant is one row, not one row per child table.

const TYPE_STYLE: Record<string, string> = {
  user: "bg-info/15 text-info",
  group: "bg-insight-enable/15 text-insight-enable",
  service_principal: "bg-insight-rewrite/15 text-insight-rewrite",
};
const TYPE_LABEL: Record<string, string> = {
  user: "user",
  group: "group",
  service_principal: "SP",
};

function TypePill({ type }: { type: string }) {
  return <span className={`pill ${TYPE_STYLE[type] ?? "bg-border/60 text-neutral"}`}>{TYPE_LABEL[type] ?? type}</span>;
}

function PrivChip({ privilege, concern, reason }: { privilege: string; concern: string | null; reason: string | null }) {
  const cls =
    concern === "critical" ? "bg-danger/20 text-danger font-medium"
    : concern === "warning" ? "bg-warning/15 text-warning"
    : "bg-border/40 text-neutral";
  return (
    <span className={`pill ${cls}`} title={reason ?? privilege}>
      {privilege.toLowerCase()}
    </span>
  );
}

function ConcernBadge({ critical, warning }: { critical: number; warning: number }) {
  if (!critical && !warning) return <span className="pill bg-success/15 text-success">ok</span>;
  return (
    <span className="inline-flex gap-1">
      {critical > 0 && <span className="pill bg-danger/15 text-danger">{critical} critical</span>}
      {warning > 0 && <span className="pill bg-warning/15 text-warning">{warning} warning</span>}
    </span>
  );
}

function GrantChips({ grants }: { grants: Grant[] }) {
  return (
    <span className="flex flex-wrap gap-1">
      {grants.map((g) => (
        <PrivChip key={g.id} privilege={g.privilege} concern={g.concern} reason={g.concern_reason} />
      ))}
    </span>
  );
}

interface ObjectRow {
  catalog: string;
  grants: Grant[];
  users: number;
  groups: number;
  sps: number;
  critical: number;
  warning: number;
}

interface PrincipalRow {
  principal: string;
  type: string;
  grants: Grant[];
  catalogs: string[];
  critical: number;
  warning: number;
}

function summarise(grants: Grant[]) {
  const critical = grants.filter((g) => g.concern === "critical").length;
  const warning = grants.filter((g) => g.concern === "warning").length;
  return { critical, warning };
}

// Grants for one catalog, grouped per principal x securable — the expanded
// "who can reach this object" panel.
function ObjectDetail({ grants }: { grants: Grant[] }) {
  const byPrincipal = useMemo(() => {
    const m = new Map<string, Grant[]>();
    for (const g of grants) m.set(g.principal, [...(m.get(g.principal) ?? []), g]);
    return [...m.entries()].sort((a, b) => {
      const ca = a[1].filter((g) => g.concern).length;
      const cb = b[1].filter((g) => g.concern).length;
      return cb - ca || b[1].length - a[1].length;
    });
  }, [grants]);
  return (
    <div className="flex flex-col gap-2 text-sm">
      {byPrincipal.map(([principal, gs]) => {
        const bySec = new Map<string, Grant[]>();
        for (const g of gs) bySec.set(g.securable, [...(bySec.get(g.securable) ?? []), g]);
        const secs = [...bySec.entries()].sort((a, b) => a[0].length - b[0].length);
        return (
          <div key={principal} className="flex flex-col gap-1 rounded-lg border border-border/60 bg-surface/40 px-3 py-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-mono text-xs text-brand-dark truncate max-w-[320px]">{principal}</span>
              <TypePill type={gs[0].principal_type} />
              {gs.some((g) => g.concern === "critical") && <span className="pill bg-danger/15 text-danger">critical</span>}
            </div>
            <div className="flex flex-col gap-1">
              {secs.map(([sec, sg]) => (
                <div key={sec} className="flex items-center gap-2 flex-wrap pl-1">
                  <span className="pill bg-border/40 text-neutral">{sg[0].level}</span>
                  <span className="font-mono text-[11px] text-neutral truncate max-w-[340px]">{sec}</span>
                  <GrantChips grants={sg} />
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// One principal's grants grouped by catalog — the expanded "what can this
// identity reach" panel.
function PrincipalDetail({ grants }: { grants: Grant[] }) {
  const byCatalog = useMemo(() => {
    const m = new Map<string, Grant[]>();
    for (const g of grants) m.set(g.catalog, [...(m.get(g.catalog) ?? []), g]);
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [grants]);
  return (
    <div className="flex flex-col gap-2 text-sm">
      {byCatalog.map(([catalog, gs]) => {
        const bySec = new Map<string, Grant[]>();
        for (const g of gs) bySec.set(g.securable, [...(bySec.get(g.securable) ?? []), g]);
        const secs = [...bySec.entries()].sort((a, b) => a[0].length - b[0].length);
        return (
          <div key={catalog} className="flex flex-col gap-1 rounded-lg border border-border/60 bg-surface/40 px-3 py-2">
            <div className="font-mono text-xs font-medium">{catalog}</div>
            <div className="flex flex-col gap-1">
              {secs.map(([sec, sg]) => (
                <div key={sec} className="flex items-center gap-2 flex-wrap pl-1">
                  <span className="pill bg-border/40 text-neutral">{sg[0].level}</span>
                  <span className="font-mono text-[11px] text-neutral truncate max-w-[340px]">{sec}</span>
                  <GrantChips grants={sg} />
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function AccessPage() {
  const { data, loading, error, cache, refresh } = useCachedApi(() => fetchGrants(), []);
  const [view, setView] = useState<"object" | "principal">("object");
  const [concernOnly, setConcernOnly] = useState(false);
  const [search, setSearch] = useState("");

  const all = useMemo(() => data?.data ?? [], [data]);

  const filtered = useMemo(() => {
    let g = all;
    if (concernOnly) g = g.filter((x) => x.concern);
    const q = search.trim().toLowerCase();
    if (q) g = g.filter((x) => x.principal.toLowerCase().includes(q) || x.securable.toLowerCase().includes(q));
    return g;
  }, [all, concernOnly, search]);

  const kpis = useMemo(() => {
    const principals = new Map<string, string>();
    for (const g of all) principals.set(g.principal, g.principal_type);
    const types = [...principals.values()];
    const { critical, warning } = summarise(all);
    return {
      principals: principals.size,
      users: types.filter((t) => t === "user").length,
      groups: types.filter((t) => t === "group").length,
      sps: types.filter((t) => t === "service_principal").length,
      catalogs: new Set(all.map((g) => g.catalog)).size,
      grants: all.length,
      critical,
      warning,
    };
  }, [all]);

  const objectRows: ObjectRow[] = useMemo(() => {
    const m = new Map<string, Grant[]>();
    for (const g of filtered) m.set(g.catalog, [...(m.get(g.catalog) ?? []), g]);
    return [...m.entries()]
      .map(([catalog, gs]) => {
        const principals = new Map<string, string>();
        for (const g of gs) principals.set(g.principal, g.principal_type);
        const types = [...principals.values()];
        return {
          catalog,
          grants: gs,
          users: types.filter((t) => t === "user").length,
          groups: types.filter((t) => t === "group").length,
          sps: types.filter((t) => t === "service_principal").length,
          ...summarise(gs),
        };
      })
      .sort((a, b) => b.critical - a.critical || b.warning - a.warning || b.grants.length - a.grants.length);
  }, [filtered]);

  const principalRows: PrincipalRow[] = useMemo(() => {
    const m = new Map<string, Grant[]>();
    for (const g of filtered) m.set(g.principal, [...(m.get(g.principal) ?? []), g]);
    return [...m.entries()]
      .map(([principal, gs]) => ({
        principal,
        type: gs[0].principal_type,
        grants: gs,
        catalogs: [...new Set(gs.map((g) => g.catalog))].sort(),
        ...summarise(gs),
      }))
      .sort((a, b) => b.critical - a.critical || b.warning - a.warning || b.grants.length - a.grants.length);
  }, [filtered]);

  const objectColumns: Column<ObjectRow>[] = [
    { key: "catalog", header: "Catalog", sortValue: (r) => r.catalog, render: (r) => <span className="font-mono text-xs font-medium">{r.catalog}</span> },
    {
      key: "who",
      header: (
        <span className="inline-flex items-center gap-1">Who has access<InfoTip text="Distinct principals holding at least one direct grant anywhere in this catalog, split by identity type." /></span>
      ),
      sortValue: (r) => r.users + r.groups + r.sps,
      render: (r) => (
        <span className="flex gap-1.5 text-xs tabular-nums">
          {r.users > 0 && <span className="pill bg-info/15 text-info">{r.users} users</span>}
          {r.groups > 0 && <span className="pill bg-insight-enable/15 text-insight-enable">{r.groups} groups</span>}
          {r.sps > 0 && <span className="pill bg-insight-rewrite/15 text-insight-rewrite">{r.sps} SPs</span>}
        </span>
      ),
    },
    { key: "grants", header: "Direct grants", align: "right", sortValue: (r) => r.grants.length, render: (r) => <span className="tabular-nums">{r.grants.length}</span> },
    {
      key: "privs",
      header: (
        <span className="inline-flex items-center gap-1">Privileges present<InfoTip text="The distinct privileges granted somewhere in this catalog; risky ones (per the Configuration-page rules) are highlighted." /></span>
      ),
      sortValue: (r) => r.grants.length,
      render: (r) => {
        const seen = new Map<string, Grant>();
        for (const g of r.grants) {
          const prev = seen.get(g.privilege);
          if (!prev || (g.concern && !prev.concern)) seen.set(g.privilege, g);
        }
        const chips = [...seen.values()].sort((a, b) => (b.concern ? 1 : 0) - (a.concern ? 1 : 0));
        return (
          <span className="flex flex-wrap gap-1 max-w-[320px]">
            {chips.slice(0, 5).map((g) => <PrivChip key={g.privilege} privilege={g.privilege} concern={g.concern} reason={g.concern_reason} />)}
            {chips.length > 5 && <span className="text-[11px] text-neutral">+{chips.length - 5}</span>}
          </span>
        );
      },
    },
    { key: "concern", header: "Concerns", align: "center", sortValue: (r) => r.critical * 1000 + r.warning, render: (r) => <ConcernBadge critical={r.critical} warning={r.warning} /> },
  ];

  const principalColumns: Column<PrincipalRow>[] = [
    { key: "principal", header: "Principal", sortValue: (r) => r.principal, render: (r) => <span className="font-mono text-xs text-brand-dark truncate max-w-[280px] inline-block">{r.principal}</span> },
    { key: "type", header: "Type", align: "center", sortValue: (r) => r.type, render: (r) => <TypePill type={r.type} /> },
    {
      key: "reach",
      header: (
        <span className="inline-flex items-center gap-1">Reach<InfoTip text="The catalogs where this principal holds at least one direct grant." /></span>
      ),
      sortValue: (r) => r.catalogs.length,
      render: (r) => (
        <span className="flex flex-wrap gap-1 max-w-[300px] items-center">
          {r.catalogs.slice(0, 3).map((c) => <span key={c} className="pill bg-border/40 text-neutral font-mono">{c}</span>)}
          {r.catalogs.length > 3 && <span className="text-[11px] text-neutral">+{r.catalogs.length - 3} more</span>}
        </span>
      ),
    },
    { key: "grants", header: "Direct grants", align: "right", sortValue: (r) => r.grants.length, render: (r) => <span className="tabular-nums">{r.grants.length}</span> },
    { key: "concern", header: "Concerns", align: "center", sortValue: (r) => r.critical * 1000 + r.warning, render: (r) => <ConcernBadge critical={r.critical} warning={r.warning} /> },
  ];

  return (
    <PageShell
      title="Access"
      subtitle="The direct Unity Catalog grant graph — ranked by concern, aggregated by object and by principal. A catalog-level grant is one row here (it covers everything inside); risk rules are documented on the Configuration page (gear button)."
      cache={cache}
      onRefresh={refresh}
    >
      {loading && !data && <LoadingCard label="Reading direct grants…" />}
      {error && <PageDataError pageId="access" message={error} />}
      {data && (
        <>
          <KpiRow cols={5}>
            <KpiCard label="Principals" value={String(kpis.principals)} tone="neutral" hint={`${kpis.users} users · ${kpis.groups} groups · ${kpis.sps} SPs`} info="Distinct identities holding at least one direct Unity Catalog grant." />
            <KpiCard label="Catalogs covered" value={String(kpis.catalogs)} tone="info" info="Catalogs with at least one direct grant (samples and internal catalogs excluded)." />
            <KpiCard label="Direct grants" value={String(kpis.grants)} tone="accent" info="Rows where access is actually SET. Inherited child rows are excluded — one catalog grant would otherwise repeat on every table inside it." />
            <KpiCard label="Critical" value={String(kpis.critical)} tone="danger" hint="all-users + full control" info="Grants giving every account identity full control of a securable (broad group AND ALL PRIVILEGES / MANAGE). Definitions on the Configuration page." />
            <KpiCard label="Warnings" value={String(kpis.warning)} tone="warning" hint="broad or wide grants" info="Grants to all-users groups, or ALL PRIVILEGES / MANAGE grants — either condition alone. Definitions on the Configuration page." />
          </KpiRow>

          <div className="flex items-center gap-2 flex-wrap">
            <div className="inline-flex rounded-lg border border-border overflow-hidden">
              {([["object", "By object"], ["principal", "By principal"]] as const).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setView(id)}
                  className={`px-3.5 py-1.5 text-xs font-medium transition ${view === id ? "bg-accent text-white" : "text-neutral hover:text-brand-dark hover:bg-surface"}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setConcernOnly(!concernOnly)}
              aria-pressed={concernOnly}
              className={`px-3 py-1.5 rounded-lg border text-xs font-medium transition ${concernOnly ? "border-danger bg-danger/10 text-danger" : "border-border text-neutral hover:text-brand-dark"}`}
            >
              ⚠ Concerning only
            </button>
            <SearchBox value={search} onChange={setSearch} placeholder="Search principal or object…" />
            <span className="text-xs text-neutral ml-auto tabular-nums">
              {filtered.length} of {all.length} grants{concernOnly ? " (concerning)" : ""}
            </span>
          </div>

          {view === "object" ? (
            <DataTable
              columns={objectColumns}
              rows={objectRows}
              rowKey={(r) => r.catalog}
              initialSort={{ key: "concern", dir: "desc" }}
              emptyMessage="No grants match."
              renderExpanded={(r) => <ObjectDetail grants={r.grants} />}
            />
          ) : (
            <DataTable
              columns={principalColumns}
              rows={principalRows}
              rowKey={(r) => r.principal}
              initialSort={{ key: "concern", dir: "desc" }}
              emptyMessage="No grants match."
              renderExpanded={(r) => <PrincipalDetail grants={r.grants} />}
            />
          )}

          <p className="text-[11px] text-neutral">
            Click a row to expand it. Direct grants only — visibility follows your own metastore permissions.
            Principal type is inferred from the name (email = user, UUID = service principal, otherwise group).
          </p>
        </>
      )}
    </PageShell>
  );
}
