import { useState } from "react";
import { fetchTables } from "../api/client";
import { useCachedApi } from "../hooks/useCachedApi";
import { PageShell, LoadingCard, PageDataError } from "../components/layout/PageShell";
import { DataTable } from "../components/shared/DataTable";
import type { Column } from "../components/shared/DataTable";
import { FilterBar, Dropdown, SearchBox } from "../components/shared/FilterBar";
import { KpiCard } from "../components/kpi/KpiCard";
import { KpiRow } from "../components/kpi/KpiRow";
import { Pill, InsightPill } from "../components/shared/Pill";
import { InfoTip } from "../components/shared/InfoTip";
import { fmtPct, fmtNum } from "../components/shared/format";
import { TableDetail } from "../components/tables/TableDetail";
import { TableHealthCard } from "../components/tables/TableHealthCard";
import type { TableRow, TablesSummary } from "../types";

// Pill styling per object type. Every value comes straight from
// information_schema.tables (plus HMS for the legacy hive_metastore listing).
const TYPE_STYLE: Record<string, string> = {
  MANAGED: "bg-success/15 text-success",
  EXTERNAL: "bg-warning/15 text-warning",
  FOREIGN: "bg-info/15 text-info",
  HMS: "bg-danger/15 text-danger",
};

function typeStyle(t: string): string {
  return TYPE_STYLE[t] ?? "bg-border/60 text-neutral";
}

export function TablesPage() {
  const [tableType, setTableType] = useState("all");
  const [catalog, setCatalog] = useState("all");
  const [search, setSearch] = useState("");
  const { data, loading, error, cache, refresh } = useCachedApi(
    () => fetchTables({ table_type: tableType, catalog, search }),
    [tableType, catalog, search],
  );

  const rows = data?.data ?? [];
  // Filter options come from the data itself (keep the active selection
  // present even when the filtered rows no longer contain it).
  const catalogOptions = Array.from(
    new Set([...rows.map((r) => r.catalog), ...(catalog !== "all" ? [catalog] : [])]),
  ).sort();
  const typeOptions = Array.from(
    new Set([...rows.map((r) => r.table_type), ...(tableType !== "all" ? [tableType] : [])]),
  ).sort();

  const summary: TablesSummary = data?.summary ?? {
    num_objects: rows.length,
    num_managed: rows.filter((r) => r.table_type === "MANAGED").length,
    num_external: rows.filter((r) => r.table_type === "EXTERNAL").length,
    pct_managed: 0,
    num_foreign: rows.filter((r) => r.table_type === "FOREIGN").length,
    num_views: rows.filter((r) => ["VIEW", "MATERIALIZED_VIEW", "METRIC_VIEW", "STREAMING_TABLE"].includes(r.table_type)).length,
    num_hms: rows.filter((r) => r.table_type === "HMS").length,
  };

  const columns: Column<TableRow>[] = [
    {
      key: "fqn",
      header: "catalog.schema.table",
      sortValue: (r) => r.fqn,
      render: (r) => <span className="text-xs font-mono">{r.fqn}</span>,
    },
    {
      key: "type",
      header: (
        <span className="inline-flex items-center gap-1">
          Type
          <InfoTip text="Object type from information_schema: MANAGED (Unity Catalog owns the storage), EXTERNAL (your location), FOREIGN (Lakehouse Federation), views / materialized views / streaming tables, or HMS (legacy hive_metastore, flagged for migration)." />
        </span>
      ),
      align: "center",
      sortValue: (r) => r.table_type,
      render: (r) => <Pill className={typeStyle(r.table_type)}>{r.table_type}</Pill>,
    },
    {
      key: "format",
      header: "Format",
      align: "center",
      sortValue: (r) => r.format,
      render: (r) => <span className="text-xs text-neutral">{r.format || "—"}</span>,
    },
    {
      key: "owner",
      header: "Owner",
      sortValue: (r) => r.owner,
      render: (r) => <span className="text-xs font-mono text-neutral truncate max-w-[200px] inline-block">{r.owner || "—"}</span>,
    },
    {
      key: "created",
      header: "Created",
      align: "right",
      sortValue: (r) => r.created,
      render: (r) => <span className="tabular-nums text-xs text-neutral">{r.created || "—"}</span>,
    },
    {
      key: "altered",
      header: (
        <span className="inline-flex items-center gap-1">
          Last altered
          <InfoTip text="When the table's definition or data was last changed (information_schema.last_altered). Old dates can indicate stale objects worth reviewing." />
        </span>
      ),
      align: "right",
      sortValue: (r) => r.last_altered,
      render: (r) => <span className="tabular-nums text-xs text-neutral">{r.last_altered || "—"}</span>,
    },
    {
      key: "rec",
      header: "Recommendation",
      sortValue: (r) => r.recommendation,
      render: (r) =>
        r.recommendation && r.recommendation !== "None" ? (
          <InsightPill type={r.recommendation} />
        ) : (
          <span className="text-neutral text-xs">—</span>
        ),
    },
  ];

  return (
    <PageShell
      title="Storage & Tables"
      subtitle="Unity Catalog inventory plus measured layout health of the most-read tables; legacy hive_metastore tables flagged for migration"
      cache={cache}
      onRefresh={refresh}
    >
      <KpiRow cols={4}>
        <KpiCard
          label="Objects inventoried"
          value={fmtNum(summary.num_objects)}
          tone="neutral"
          hint="tables · views · foreign"
          info="Everything in information_schema.tables outside system/samples/internal catalogs, plus the legacy hive_metastore listing."
        />
        <KpiCard
          label="Managed vs External"
          value={`${summary.num_managed} / ${summary.num_external}`}
          tone="success"
          hint={summary.num_managed + summary.num_external > 0 ? `${fmtPct(summary.pct_managed)} managed` : "no base tables"}
          info="Managed tables have their storage lifecycle handled by Unity Catalog (auto-maintenance eligible). External tables point at a location you own and maintain yourself."
        />
        <KpiCard
          label="Foreign / Views"
          value={`${summary.num_foreign} / ${summary.num_views}`}
          tone="info"
          hint="federated / derived"
          info="FOREIGN objects come from Lakehouse Federation connections (queried in place, no Databricks storage). Views covers views, materialized views, metric views and streaming tables."
        />
        <KpiCard
          label="HMS legacy"
          value={String(summary.num_hms)}
          tone={summary.num_hms > 0 ? "danger" : "success"}
          hint={summary.num_hms > 0 ? "migrate to Unity Catalog" : "none found"}
          info="Tables still in the legacy hive_metastore: no lineage, no fine-grained grants, no system-table coverage. Each is flagged with migration steps."
        />
      </KpiRow>

      <TableHealthCard />

      <FilterBar>
        <Dropdown
          label="Type"
          value={tableType}
          onChange={setTableType}
          options={[{ value: "all", label: "All types" }, ...typeOptions.map((t) => ({ value: t, label: t }))]}
        />
        <Dropdown
          label="Catalog"
          value={catalog}
          onChange={setCatalog}
          options={[{ value: "all", label: "All catalogs" }, ...catalogOptions.map((c) => ({ value: c, label: c }))]}
        />
        <SearchBox value={search} onChange={setSearch} placeholder="Search name or owner…" />
      </FilterBar>

      {loading && <LoadingCard />}
      {error && <PageDataError pageId="tables" message={error} />}
      {data && (
        <DataTable
          columns={columns}
          rows={data.data}
          rowKey={(r) => r.fqn}
          initialSort={{ key: "fqn", dir: "asc" }}
          emptyMessage="No objects match the current filters."
          renderExpanded={(r) => <TableDetail row={r} />}
        />
      )}
    </PageShell>
  );
}
