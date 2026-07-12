import { useState } from "react";
import { fetchTableProbe } from "../../api/client";
import type { TableProbe, TableRow } from "../../types";
import { InsightPill } from "../shared/Pill";
import { InfoTip } from "../shared/InfoTip";
import { fmtBytes, fmtNum } from "../shared/format";
import { TableFlagPills } from "./TableHealthCard";

// Object types DESCRIBE DETAIL cannot probe (no physical Delta layout).
const NOT_PROBEABLE = new Set(["VIEW", "MATERIALIZED_VIEW", "METRIC_VIEW", "FOREIGN"]);

/**
 * Expandable per-table detail. For legacy hive_metastore tables it shows the
 * migration recommendation + concrete steps. For Unity Catalog objects it
 * shows the real catalog metadata, plus an on-demand DESCRIBE DETAIL probe
 * (run as the signed-in viewer) for physical layout — size, files,
 * partition/clustering keys and Predictive Optimization activity.
 */
export function TableDetail({ row }: { row: TableRow }) {
  const isHms = row.table_type === "HMS";
  const probeable = !NOT_PROBEABLE.has(row.table_type);
  const [probe, setProbe] = useState<TableProbe | null>(null);
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);

  async function onProbe() {
    setProbing(true);
    setProbeError(null);
    try {
      const r = await fetchTableProbe(row.fqn);
      setProbe(r.data);
    } catch (e: unknown) {
      setProbeError(e instanceof Error ? e.message : String(e));
    } finally {
      setProbing(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 text-sm">
      {isHms && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {row.recommendation !== "None" && <InsightPill type={row.recommendation} />}
            <span className="text-neutral">{row.rationale}</span>
          </div>
          {row.next_steps.length > 0 && (
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-neutral mb-1.5">
                Migration steps
              </div>
              <ol className="list-decimal list-inside text-xs text-neutral space-y-1 marker:text-accent">
                {row.next_steps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            </div>
          )}
        </>
      )}

      {!isHms && (
        <div className="rounded-lg border border-border bg-surface/50 p-3 max-w-xl">
          <div className="text-xs font-semibold uppercase tracking-wide text-neutral mb-2 flex items-center gap-1">
            Catalog metadata
            <InfoTip text="Everything shown comes from system.information_schema.tables — no estimates." />
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
            <dt className="text-neutral">Type</dt>
            <dd className="text-right">{row.table_type}</dd>
            <dt className="text-neutral">Format</dt>
            <dd className="text-right">{row.format || "—"}</dd>
            <dt className="text-neutral">Owner</dt>
            <dd className="text-right font-mono">{row.owner || "—"}</dd>
            <dt className="text-neutral">Created</dt>
            <dd className="text-right tabular-nums">{row.created || "—"}</dd>
            <dt className="text-neutral">Last altered</dt>
            <dd className="text-right tabular-nums">{row.last_altered || "—"}</dd>
          </dl>
        </div>
      )}

      {/* On-demand physical probe — one DESCRIBE DETAIL, run as the viewer. */}
      {probeable && !probe && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onProbe}
            disabled={probing}
            className="px-3 py-1.5 rounded-lg border border-border text-xs text-neutral hover:text-brand-dark hover:bg-surface transition disabled:opacity-60"
          >
            {probing ? "Probing…" : "Probe physical layout"}
          </button>
          <InfoTip text="Runs DESCRIBE DETAIL on this one table with your permissions: size, file count, partition / liquid-clustering keys, plus Predictive Optimization activity — and deterministic best-practice flags over those facts." />
          {probeError && <span className="text-xs text-danger">{probeError}</span>}
        </div>
      )}

      {probe && (
        <div className="rounded-lg border border-border bg-surface/50 p-3 max-w-xl flex flex-col gap-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-neutral flex items-center gap-1">
            Physical layout (DESCRIBE DETAIL)
            <InfoTip text="Measured just now, as you. Flags are the same deterministic best-practice checks used by the layout-health list above." />
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
            <dt className="text-neutral">Size</dt>
            <dd className="text-right tabular-nums">{fmtBytes(probe.size_bytes)}</dd>
            <dt className="text-neutral">Files</dt>
            <dd className="text-right tabular-nums">{fmtNum(probe.num_files)}{probe.avg_file_mb ? ` · avg ${probe.avg_file_mb} MB` : ""}</dd>
            <dt className="text-neutral">Format</dt>
            <dd className="text-right">{probe.format || "—"}</dd>
            <dt className="text-neutral">Liquid clustering</dt>
            <dd className="text-right font-mono">{probe.clustering_cols.join(", ") || "—"}</dd>
            <dt className="text-neutral">Partitions</dt>
            <dd className="text-right font-mono">{probe.partition_cols.join(", ") || "—"}</dd>
            <dt className="text-neutral">Last modified</dt>
            <dd className="text-right tabular-nums">{probe.last_modified || "—"}</dd>
            <dt className="text-neutral">PO ops (30d)</dt>
            <dd className="text-right tabular-nums">{probe.po_ops_30d > 0 ? `${probe.po_ops_30d} (${probe.po_types})` : "none seen"}</dd>
          </dl>
          <div className="flex items-start gap-2 border-t border-border/60 pt-2">
            <TableFlagPills flags={probe.flags} />
          </div>
          {probe.flags.length > 0 && (
            <ul className="flex flex-col gap-1 text-xs">
              {probe.flags.map((f) => (
                <li key={f.id} className="text-neutral">
                  <span className="font-medium text-brand-dark">{f.label}: </span>
                  {f.action}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {row.caveat && (
        <p className="text-[11px] text-neutral border-t border-border pt-2">{row.caveat}</p>
      )}
    </div>
  );
}
