import { fetchGenieCost } from "../../api/client";
import { useApi } from "../../hooks/useApi";
import { useCurrency } from "../../store/appStore";
import { fmtMoney, fmtNum } from "../shared/format";
import { LoadingCard, PageDataError } from "../layout/PageShell";
import { InfoTip } from "../shared/InfoTip";
import type { GenieCost } from "../../types";

// "Genie spend" card. Genie cost by SURFACE (usage_metadata.genie.surface,
// shown as billed with the case fixed: Genie Code / Genie One / Genie
// Agents), per workspace × user, DBUs + list $. Rendered on the Genie page,
// the Recommendations cost-attribution panel (estate) and the Workspaces
// drill-down (per workspace). List-price $, dual-currency aware. Calls NO
// model — deterministic attribution over billing data.

// Stable colour per surface (Tailwind classes present in the design system).
const SURFACE_STYLE: Record<string, { bar: string; pill: string; dot: string }> = {
  GENIE_CODE: { bar: "bg-insight-rewrite", pill: "bg-insight-rewrite/15 text-insight-rewrite", dot: "bg-insight-rewrite" },
  GENIE_ONE: { bar: "bg-insight-enable", pill: "bg-insight-enable/15 text-insight-enable", dot: "bg-insight-enable" },
  GENIE_AGENTS: { bar: "bg-info", pill: "bg-info/15 text-info", dot: "bg-info" },
  UNKNOWN: { bar: "bg-neutral", pill: "bg-border text-neutral", dot: "bg-neutral" },
};
export function surfaceStyle(surface: string) {
  return SURFACE_STYLE[surface] ?? SURFACE_STYLE.UNKNOWN;
}

// Plain-language description per billed surface value, surfaced as tooltips.
const SURFACE_HELP: Record<string, string> = {
  GENIE_CODE:
    "Genie Code: the natural-language-to-SQL assistant inside the SQL editor and notebooks. Technical users prompting Genie inline.",
  GENIE_ONE:
    "Genie One: the conversational Genie experience — users ask questions in plain English against a Genie space and get answers back.",
  GENIE_AGENTS:
    "Genie Agents: Genie called programmatically as a tool inside an agent (agent surface / Conversation API), not a human in a UI.",
  UNKNOWN:
    "Genie usage with no surface recorded in billing. Counted in totals but not attributed to a surface.",
};
export function surfaceHelp(surface: string): string {
  return SURFACE_HELP[surface] ?? SURFACE_HELP.UNKNOWN;
}

function SurfaceBadge({ surface, label }: { surface: string; label: string }) {
  return <span className={`pill ${surfaceStyle(surface).pill}`}>{label}</span>;
}

// 100%-stacked split bar across all surfaces + a legend row per surface.
function SurfaceSplitBar({ data }: { data: GenieCost }) {
  const cur = useCurrency();
  const totals = data.surface_totals.filter((s) => s.list_usd > 0);
  const total = Math.max(1, totals.reduce((a, s) => a + s.list_usd, 0));
  return (
    <div>
      <div className="flex h-3 w-full overflow-hidden rounded-full border border-border">
        {totals.map((s) => (
          <div
            key={s.surface}
            className={surfaceStyle(s.surface).bar}
            style={{ width: `${(s.list_usd / total) * 100}%` }}
            title={`${s.label} · ${fmtMoney(s.list_usd, cur, { compact: true })}`}
          />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {totals.map((s) => (
          <span key={s.surface} className="flex items-center gap-1.5">
            <span className={`h-2.5 w-2.5 rounded-sm ${surfaceStyle(s.surface).dot}`} /> {s.label}
            <InfoTip text={surfaceHelp(s.surface)} label={`What is ${s.label}?`} />
            <span className="tabular-nums text-neutral">
              {fmtMoney(s.list_usd, cur, { compact: true })} · {fmtNum(s.dbus, { compact: true })} DBUs
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

export function GenieSpendCard({
  workspace,
  title = "Genie spend by surface",
  maxRows = 12,
}: {
  workspace?: string;
  title?: string;
  maxRows?: number;
}) {
  const cur = useCurrency();
  const { data, loading, error } = useApi(
    () => fetchGenieCost(workspace ? { workspace } : {}),
    [workspace],
  );

  if (loading && !data) return <LoadingCard label="Loading Genie spend…" />;
  if (error) return <PageDataError pageId="genie" message={error} />;
  if (!data) return null;

  const gc = data.data;
  const rows = gc.breakdown.slice(0, maxRows);

  return (
    <div className="card flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h3 className="text-sm font-semibold flex items-center gap-1.5">
          {title}
          <InfoTip text="Genie DBU spend split by surface (usage_metadata.genie.surface, shown as billed): Genie Code = SQL editor / notebook, Genie One = conversational Genie, Genie Agents = agent surface. Attributed per workspace and user from billing data. No model is called." />
        </h3>
        <span className="text-xs text-neutral tabular-nums">
          {fmtMoney(gc.summary.total_list_cost_usd, cur, { compact: true })} list ·{" "}
          {gc.summary.distinct_users} users · {gc.month}
        </span>
      </div>

      <SurfaceSplitBar data={gc} />

      {/* Per workspace × user × surface rows */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-neutral border-b border-border">
              <th className="py-1.5 pr-3 font-medium">Workspace</th>
              <th className="py-1.5 pr-3 font-medium">User</th>
              <th className="py-1.5 pr-3 font-medium">
                <span className="inline-flex items-center gap-1">Surface<InfoTip text="Which Genie surface generated the usage, as billed: Genie Code (editor/notebook), Genie One (conversational), or Genie Agents (agent surface)." /></span>
              </th>
              <th className="py-1.5 pr-3 font-medium text-right">DBUs</th>
              <th className="py-1.5 pr-3 font-medium text-right">
                <span className="inline-flex items-center gap-1">List $<InfoTip text="Cost at published list price (DBUs times effective list rate)." /></span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-b border-border/50">
                <td className="py-1.5 pr-3 font-mono text-neutral truncate max-w-[160px]">{r.workspace}</td>
                <td className="py-1.5 pr-3 font-mono text-brand-dark truncate max-w-[180px]">{r.user_identity}</td>
                <td className="py-1.5 pr-3"><SurfaceBadge surface={r.surface} label={r.label} /></td>
                <td className="py-1.5 pr-3 text-right tabular-nums text-neutral">{fmtNum(r.total_dbus)}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{fmtMoney(r.total_list_cost_usd, cur)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Caveats */}
      <ul className="flex flex-col gap-1 text-[11px] text-neutral border-t border-border pt-2">
        {gc.caveats.map((c, i) => (
          <li key={i} className="flex gap-1.5">
            <span className="text-warning shrink-0" aria-hidden>·</span>
            <span>{c}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
