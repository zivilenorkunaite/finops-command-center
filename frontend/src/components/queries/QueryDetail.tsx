import { useState } from "react";
import { InsightPill } from "../shared/Pill";
import { InfoTip } from "../shared/InfoTip";
import { QueryFlags } from "./QueryFlags";
import { fmtMoney, fmtBytes, fmtPct, fmtNum } from "../shared/format";
import { useCurrency } from "../../store/appStore";
import { postQueryAnalyse } from "../../api/client";
import type { QueryRow } from "../../types";

function Metric({ label, value, tone, info }: { label: string; value: string; tone?: string; info?: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wide text-neutral flex items-center gap-1">
        {label}
        {info && <InfoTip text={info} label={`What is ${label}?`} />}
      </span>
      <span className={`text-sm tabular-nums font-medium ${tone ?? ""}`}>{value}</span>
    </div>
  );
}

function fmtDur(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

// Wall-time phases in display order — keys match the backend rollup columns.
const PHASES: { key: string; label: string; color: string }[] = [
  { key: "queue_ms", label: "queued at capacity", color: "#C0392B" },
  { key: "compute_wait_ms", label: "waiting for compute", color: "#F59E0B" },
  { key: "compile_ms", label: "compiling", color: "#8B5CF6" },
  { key: "exec_ms", label: "executing", color: "#0D9488" },
  { key: "fetch_ms", label: "fetching results", color: "#3B82F6" },
];

// Where the wall time went — measured per-phase shares from query history.
function PhaseBreakdown({ shares }: { shares: Record<string, number> }) {
  const parts = PHASES.map((p) => ({ ...p, share: shares[p.key] ?? 0 })).filter((p) => p.share >= 0.01);
  if (!parts.length) return null;
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-neutral mb-1.5 flex items-center gap-1">
        Where the time went
        <InfoTip text="Each phase's share of this statement's total wall time, measured from query history: queueing at warehouse capacity, waiting for compute start (cold warehouse), compilation, execution, and returning results to the client." />
      </div>
      <div className="flex h-2.5 w-full overflow-hidden rounded-full border border-border bg-surface">
        {parts.map((p) => (
          <div key={p.key} title={`${p.label} · ${fmtPct(p.share)}`} style={{ width: `${p.share * 100}%`, backgroundColor: p.color }} />
        ))}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
        {parts.map((p) => (
          <span key={p.key} className="inline-flex items-center gap-1.5 text-[11px] text-neutral">
            <span className="h-2 w-2 rounded-sm shrink-0" style={{ backgroundColor: p.color }} />
            {p.label} <span className="tabular-nums text-brand-dark">{fmtPct(p.share)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** Expanded row: full SQL, measured metrics + wall-time breakdown, and the
 *  recommendation — deterministic steps plus the per-fingerprint ai_query
 *  review (on demand or from the background batch). */
export function QueryDetail({ row }: { row: QueryRow }) {
  const cur = useCurrency();
  const [advice, setAdvice] = useState<string | null>(row.ai_advice ?? null);
  const [model, setModel] = useState<string | null>(row.ai_model ?? null);
  const [reviewing, setReviewing] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);

  async function onReview() {
    setReviewing(true);
    setReviewError(null);
    try {
      const r = await postQueryAnalyse(row.statement_id);
      setAdvice(r.data.ai_advice);
      setModel(r.data.ai_model);
    } catch (e: unknown) {
      setReviewError(e instanceof Error ? e.message : String(e));
    } finally {
      setReviewing(false);
    }
  }

  const spillTone = row.spill_gb >= 20 ? "text-danger" : "";
  const pruneTone = row.pruning_efficiency < 0.3 ? "text-danger" : row.pruning_efficiency < 0.5 ? "text-warning" : "";
  const singleRun = row.runs === 1;
  const provenance = [
    row.source_label && `source: ${row.source_label}`,
    row.client_app && `client: ${row.client_app}`,
    row.last_run && `last run ${row.last_run}`,
  ].filter(Boolean).join(" · ");

  return (
    <div className="grid lg:grid-cols-2 gap-5 text-sm">
      {/* Left: SQL + measured metrics */}
      <div className="flex flex-col gap-3">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-neutral mb-1">
            Full SQL {row.target_table && <span className="normal-case text-neutral/70">· {row.target_table}</span>}
          </div>
          <pre className="bg-surface rounded-lg p-3 text-xs font-mono whitespace-pre-wrap break-words overflow-x-auto border border-border">
            {row.query_text}
          </pre>
          {provenance && <div className="mt-1 text-[11px] text-neutral">{provenance}</div>}
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-neutral mb-1.5">Statement metrics</div>
          <div className="grid grid-cols-3 gap-x-4 gap-y-3">
            <Metric
              label="Runs"
              value={`${row.runs.toLocaleString("en-AU")}${row.cached_runs ? ` (${row.cached_runs} cached)` : ""}`}
              info="Number of times this statement ran over the selected time range; cached = served from the result cache without recomputing."
            />
            {singleRun ? (
              <Metric label="Duration" value={fmtDur(row.p95_s)} info="Wall-clock duration of the single run in the window (percentiles need repeated runs)." />
            ) : (
              <Metric
                label="p50 / p95"
                value={`${fmtDur(row.p50_s)} / ${fmtDur(row.p95_s)}`}
                info="Median (p50) and 95th-percentile (p95) duration. p95 shows the slow-run tail; a large gap means inconsistent performance."
              />
            )}
            <Metric label="Bytes read" value={fmtBytes(row.bytes_read)} info="Amount of data the query scanned from storage. Large reads with low pruning point to a full-table scan." />
            <Metric
              label="Pruning eff."
              value={fmtPct(row.pruning_efficiency)}
              tone={pruneTone}
              info="Fraction of data skipped by file and data skipping instead of being scanned. Higher is better; low values mean the query reads too much."
            />
            <Metric
              label="Spill"
              value={`${row.spill_gb.toFixed(1)} GB`}
              tone={spillTone}
              info="Data spilled from memory to disk during execution. Spill signals the warehouse is undersized or the query is inefficient."
            />
            <Metric
              label="Rows out"
              value={row.produced_rows == null ? "—" : fmtNum(row.produced_rows, { compact: true })}
              info="Rows the statement returned to the client over the window ('—' for runs mirrored before this was captured). Millions of returned rows usually means an extract that belongs in a job or an aggregate."
            />
            <Metric label="Cost (window)" value={fmtMoney(row.cost_usd, cur)} info="This statement's share of its warehouse's billed cost over the selected window, allocated by task time — an estimate; warehouse idle time is spread across the statements that ran." />
          </div>
        </div>
        {row.phase_shares && <PhaseBreakdown shares={row.phase_shares} />}
        <div>
          <div className="text-[11px] uppercase tracking-wide text-neutral mb-1.5">Flags</div>
          <QueryFlags flags={row.flags} />
        </div>
      </div>

      {/* Right: recommendation */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <InsightPill type={row.insight_type} />
          {typeof row.confidence === "number" && (
            <span className="text-xs text-neutral">confidence {(row.confidence * 100).toFixed(0)}%</span>
          )}
        </div>
        <p className="text-sm leading-relaxed">{row.rationale}</p>

        {advice && (
          <div className="card border-l-4 border-l-info py-2.5 flex flex-col gap-1">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="pill bg-info/15 text-info">AI review</span>
              <span className="text-[11px] text-neutral">
                ai_query{model ? ` · ${model}` : ""} · run as you, grounded in this statement's SQL + measured metrics
              </span>
            </div>
            <div className="text-xs leading-relaxed whitespace-pre-wrap text-brand-dark/90">{advice}</div>
          </div>
        )}
        {!advice && row.ai_pending && (
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={onReview}
              disabled={reviewing}
              className="px-3 py-1.5 rounded-lg border border-border text-xs text-neutral hover:text-brand-dark hover:bg-surface transition disabled:opacity-60"
            >
              {reviewing ? "Reviewing…" : "Review with AI now"}
            </button>
            <InfoTip text="One ai_query call on the configured Claude endpoint, run with your permissions over this statement's SQL and measured metrics. Reviews also happen in a background batch, costliest statements first — this button just skips the queue." />
            {reviewError && <span className="text-xs text-danger">{reviewError}</span>}
          </div>
        )}

        {row.next_steps.length > 0 && (
          <div>
            <div className="text-[11px] uppercase tracking-wide text-neutral mb-1.5">Next steps</div>
            <ol className="list-decimal list-inside text-xs text-neutral space-y-1">
              {row.next_steps.map((s, i) => (
                <li key={i}>
                  <code className="text-brand-dark">{s}</code>
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </div>
  );
}
