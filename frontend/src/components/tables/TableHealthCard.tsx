import { fetchTablesHealth } from "../../api/client";
import { useCachedApi } from "../../hooks/useCachedApi";
import { CacheBadge, LoadingCard, PageDataError } from "../layout/PageShell";
import { DataTable } from "../shared/DataTable";
import type { Column } from "../shared/DataTable";
import { Pill } from "../shared/Pill";
import { InfoTip } from "../shared/InfoTip";
import { fmtBytes, fmtNum } from "../shared/format";
import type { TableFlag, TableHealthRow } from "../../types";

const TYPE_STYLE: Record<string, string> = {
  MANAGED: "bg-success/15 text-success",
  EXTERNAL: "bg-warning/15 text-warning",
};

// Flag pills: hover shows the concrete fix; expanding the row lists them all.
export function TableFlagPills({ flags }: { flags: TableFlag[] }) {
  if (!flags.length) return <span className="pill bg-success/15 text-success">ok</span>;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {flags.map((f) => (
        <span key={f.id} className="pill bg-warning/15 text-warning whitespace-nowrap" title={f.action}>
          {f.label}
        </span>
      ))}
    </span>
  );
}

function LayoutCell({ r }: { r: TableHealthRow }) {
  if (r.clustering_cols.length)
    return (
      <span className="pill bg-info/15 text-info font-mono text-[10px]" title="Liquid clustering keys">
        LC: {r.clustering_cols.join(", ")}
      </span>
    );
  if (r.partition_cols.length)
    return (
      <span className="pill bg-warning/15 text-warning font-mono text-[10px]" title="Hive-style partition columns">
        part: {r.partition_cols.join(", ")}
      </span>
    );
  return <span className="text-neutral text-xs">—</span>;
}

function Chip({ label, value, tone = "" }: { label: string; value: string; tone?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <span className="text-neutral">{label}</span>
      <span className={`font-semibold tabular-nums ${tone}`}>{value}</span>
    </span>
  );
}

// Measured layout health of the most-read tables: DESCRIBE DETAIL probes (as
// the viewer) + Predictive Optimization ops history, cached like every page
// object. Flags are deterministic best-practice checks over measured facts.
export function TableHealthCard() {
  const { data, loading, error, cache, refresh } = useCachedApi(() => fetchTablesHealth(), []);
  const h = data?.data;
  const rows = h?.rows ?? [];

  const columns: Column<TableHealthRow>[] = [
    {
      key: "fqn",
      header: "catalog.schema.table",
      sortValue: (r) => r.fqn,
      render: (r) => <span className="text-xs font-mono">{r.fqn}</span>,
    },
    {
      key: "type",
      header: "Type",
      align: "center",
      sortValue: (r) => r.table_type,
      render: (r) => <Pill className={TYPE_STYLE[r.table_type] ?? "bg-border/60 text-neutral"}>{r.table_type}</Pill>,
    },
    {
      key: "size",
      header: "Size",
      align: "right",
      sortValue: (r) => r.size_bytes,
      render: (r) => <span className="tabular-nums text-xs">{fmtBytes(r.size_bytes)}</span>,
    },
    {
      key: "files",
      header: "Files",
      align: "right",
      sortValue: (r) => r.num_files,
      render: (r) => <span className="tabular-nums text-xs text-neutral">{fmtNum(r.num_files)}</span>,
    },
    {
      key: "avg",
      header: (
        <span className="inline-flex items-center gap-1">
          Avg file
          <InfoTip text="size ÷ file count. Many small files slow reads and inflate metadata — OPTIMIZE compacts them (Predictive Optimization does it automatically on managed tables)." />
        </span>
      ),
      align: "right",
      sortValue: (r) => r.avg_file_mb,
      render: (r) => (
        <span className="tabular-nums text-xs text-neutral">
          {r.num_files > 0 ? (r.avg_file_mb >= 0.1 ? `${r.avg_file_mb} MB` : "<0.1 MB") : "—"}
        </span>
      ),
    },
    {
      key: "layout",
      header: (
        <span className="inline-flex items-center gap-1">
          Layout
          <InfoTip text="Liquid clustering (LC) keys or Hive-style partition columns from DESCRIBE DETAIL. Liquid clustering is the current best practice; partitioning sub-TB tables usually hurts." />
        </span>
      ),
      align: "center",
      sortValue: (r) => (r.clustering_cols.length ? 2 : r.partition_cols.length ? 1 : 0),
      render: (r) => <LayoutCell r={r} />,
    },
    {
      key: "po",
      header: (
        <span className="inline-flex items-center gap-1">
          PO 30d
          <InfoTip text="Successful Predictive Optimization operations on this table in the last 30 days (system.storage.predictive_optimization_operations_history) — automatic OPTIMIZE / VACUUM / clustering on managed tables." />
        </span>
      ),
      align: "right",
      sortValue: (r) => r.po_ops_30d,
      render: (r) =>
        r.po_ops_30d > 0 ? (
          <span className="tabular-nums text-xs" title={`${r.po_ops_30d} ops (${r.po_types}) — last ${r.po_last}`}>
            {fmtNum(r.po_ops_30d)}
          </span>
        ) : (
          <span className="text-neutral text-xs">—</span>
        ),
    },
    {
      key: "reads",
      header: (
        <span className="inline-flex items-center gap-1">
          Reads 30d
          <InfoTip text="Read events in system.access.table_lineage over the last 30 days — the ranking that picked this table for probing." />
        </span>
      ),
      align: "right",
      sortValue: (r) => r.reads_30d,
      render: (r) => <span className="tabular-nums text-xs">{fmtNum(r.reads_30d)}</span>,
    },
    {
      key: "flags",
      header: "Flags",
      sortValue: (r) => r.flags.length,
      render: (r) => <TableFlagPills flags={r.flags} />,
    },
  ];

  return (
    <div className="card flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold flex items-center gap-1.5">
            Layout health — most-read tables
            <InfoTip text="Every figure is measured: the top tables by 30-day lineage reads are probed with DESCRIBE DETAIL under your permissions; Predictive Optimization activity comes from its ops history. Flags are deterministic best-practice checks — small files, Hive-style partitions on sub-TB tables, missing clustering, external tables." />
          </h3>
          <p className="text-xs text-neutral mt-1">
            Sizing every inventoried table would take thousands of statements, so probing is bounded to the
            tables workloads actually read — expand a row in the inventory below to probe any other table on
            demand.
          </p>
        </div>
        {cache && <CacheBadge meta={cache} onRefresh={refresh} />}
      </div>

      {h && (
        <div className="flex items-center gap-4 flex-wrap border-y border-border/60 py-2">
          <Chip label="Probed" value={String(h.probed)} />
          <Chip label="Flagged" value={String(h.flagged)} tone={h.flagged > 0 ? "text-warning" : "text-success"} />
          <Chip label="Probed size" value={fmtBytes(h.total_size_bytes)} />
          {h.po_available ? (
            <Chip label="PO ops 30d (estate)" value={fmtNum(h.po_ops_30d_estate)} tone="text-info" />
          ) : (
            <span className="text-xs text-neutral">Predictive Optimization history not readable — PO columns omitted</span>
          )}
          {h.skipped_no_access > 0 && (
            <span className="text-xs text-neutral">
              {h.skipped_no_access} top-read table(s) could not be described (permissions or transient
              warehouse error) — Refresh retries them
            </span>
          )}
        </div>
      )}

      {loading && !h && <LoadingCard label="Probing the most-read tables (DESCRIBE DETAIL, first build takes a minute or two)…" />}
      {error && <PageDataError pageId="tables" message={error} />}
      {h && (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.fqn}
          initialSort={{ key: "size", dir: "desc" }}
          emptyMessage="No probeable tables found in the top-read set."
          renderExpanded={(r) => (
            <div className="flex flex-col gap-2 text-xs">
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-neutral">
                <span>Owner: <span className="font-mono text-brand-dark">{r.owner || "—"}</span></span>
                <span>Format: <span className="text-brand-dark">{r.format || "—"}</span></span>
                <span>Last modified: <span className="tabular-nums text-brand-dark">{r.last_modified || "—"}</span></span>
                {r.po_ops_30d > 0 && <span>PO ops 30d: <span className="text-brand-dark">{r.po_ops_30d} ({r.po_types})</span></span>}
              </div>
              {r.flags.length > 0 ? (
                <ul className="flex flex-col gap-1">
                  {r.flags.map((f) => (
                    <li key={f.id} className="flex gap-2">
                      <span className="pill bg-warning/15 text-warning shrink-0">{f.label}</span>
                      <span className="text-neutral">{f.action}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="text-success">No layout flags — file sizes and clustering look healthy.</span>
              )}
            </div>
          )}
        />
      )}

      {h && (
        <p className="text-[11px] text-neutral">Selection: {h.criteria}.</p>
      )}
    </div>
  );
}
