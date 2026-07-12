import { useState } from "react";
import { fetchTagSearch } from "../../api/client";
import { useApi } from "../../hooks/useApi";
import { LoadingCard, PageDataError } from "../layout/PageShell";
import { InfoTip } from "../shared/InfoTip";
import { fmtMoney } from "../shared/format";
import type { MoneyCurrency } from "../shared/format";

// Per-tag drill-down: everything carrying the tag — billed resources with
// month-to-date cost, value breakdown, and UC securables. Rendered inline
// when a catalog row is expanded.
export function TagExplorer({ tagKey, cur }: { tagKey: string; cur: MoneyCurrency }) {
  const [value, setValue] = useState("");
  const [applied, setApplied] = useState<string>("");
  const { data, loading, error } = useApi(
    () => fetchTagSearch(tagKey, applied || undefined),
    [tagKey, applied],
  );
  const d = data?.data;

  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-mono text-xs text-brand-dark">{tagKey}</span>
        <input
          type="search"
          placeholder="Filter by value (exact)…"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && setApplied(value.trim())}
          className="w-56 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs focus:outline-none focus:border-accent"
        />
        <button
          type="button"
          onClick={() => setApplied(value.trim())}
          className="px-2.5 py-1.5 rounded-lg border border-border text-xs text-neutral hover:text-brand-dark hover:bg-surface transition"
        >
          Apply
        </button>
        {applied && (
          <button type="button" onClick={() => { setValue(""); setApplied(""); }} className="text-xs text-neutral hover:text-brand-dark">
            × clear value
          </button>
        )}
        {d && (
          <span className="ml-auto text-xs text-neutral">
            Month-to-date spend carrying this tag{applied ? ` = ${applied}` : ""}:{" "}
            <span className="font-semibold text-brand-dark tabular-nums">{fmtMoney(d.total_usd, cur, { compact: true })}</span>
          </span>
        )}
      </div>

      {loading && <LoadingCard label="Searching usage + Unity Catalog tags…" />}
      {error && <PageDataError pageId="tags" message={error} />}
      {d && (
        <>
          {d.by_value.length > 1 && !applied && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[11px] uppercase tracking-wide text-neutral">Top values</span>
              {d.by_value.slice(0, 10).map((v) => (
                <button
                  key={v.value || "(empty)"}
                  type="button"
                  onClick={() => { setValue(v.value); setApplied(v.value); }}
                  className="pill bg-border/40 text-neutral hover:text-brand-dark transition font-mono text-[10px]"
                  title={`${fmtMoney(v.usd, cur, { compact: true })} MTD — click to filter`}
                >
                  {v.value || "(empty)"} · {fmtMoney(v.usd, cur, { compact: true })}
                </button>
              ))}
            </div>
          )}

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 items-start">
            <div>
              <div className="text-[11px] uppercase tracking-wide text-neutral mb-1.5 flex items-center gap-1">
                Billed resources carrying the tag
                <InfoTip text="From system.billing.usage: assets whose usage rows carry this tag this month, with the full list-price cost of those rows. A row's cost counts fully — tags don't split a usage row." />
              </div>
              {d.resources.length === 0 ? (
                <p className="text-xs text-neutral">No billed usage carries this tag this month.</p>
              ) : (
                <div className="max-h-72 overflow-y-auto rounded-lg border border-border">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-card">
                      <tr className="text-left text-neutral border-b border-border">
                        <th className="py-1.5 px-3 font-medium">Type</th>
                        <th className="py-1.5 pr-3 font-medium">Asset</th>
                        <th className="py-1.5 pr-3 font-medium">Workspace</th>
                        <th className="py-1.5 pr-3 font-medium">Value</th>
                        <th className="py-1.5 pr-3 font-medium text-right">MTD $</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.resources.map((r, i) => (
                        <tr key={i} className="border-b border-border/50">
                          <td className="py-1.5 px-3 text-neutral whitespace-nowrap">{r.asset_type}</td>
                          <td className="py-1.5 pr-3 font-mono truncate max-w-[220px]">{r.asset}</td>
                          <td className="py-1.5 pr-3 font-mono text-neutral">{r.workspace}</td>
                          <td className="py-1.5 pr-3 font-mono text-neutral truncate max-w-[140px]">{r.tag_value}</td>
                          <td className="py-1.5 pr-3 text-right tabular-nums">{fmtMoney(r.usd, cur, { compact: true })}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div>
              <div className="text-[11px] uppercase tracking-wide text-neutral mb-1.5 flex items-center gap-1">
                Unity Catalog securables tagged
                <InfoTip text="From the information_schema *_tags views: catalogs, schemas, tables, columns and volumes carrying this tag. Securables have no billed cost of their own — cost lives with the compute that reads them." />
              </div>
              {d.securables.length === 0 ? (
                <p className="text-xs text-neutral">No visible Unity Catalog securable carries this tag.</p>
              ) : (
                <div className="max-h-72 overflow-y-auto rounded-lg border border-border">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-card">
                      <tr className="text-left text-neutral border-b border-border">
                        <th className="py-1.5 px-3 font-medium">Level</th>
                        <th className="py-1.5 pr-3 font-medium">Securable</th>
                        <th className="py-1.5 pr-3 font-medium">Value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.securables.map((s, i) => (
                        <tr key={i} className="border-b border-border/50">
                          <td className="py-1.5 px-3 text-neutral">{s.level}</td>
                          <td className="py-1.5 pr-3 font-mono truncate max-w-[320px]">{s.securable}</td>
                          <td className="py-1.5 pr-3 font-mono text-neutral truncate max-w-[140px]">{s.tag_value}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
