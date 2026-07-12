import { useState } from "react";
import { saveAppIdentityLabel, postCacheRefresh } from "../../api/client";
import { InfoTip } from "../shared/InfoTip";
import { fmtMoney, fmtNum } from "../shared/format";
import type { MoneyCurrency } from "../shared/format";
import type { OboAttributionRow } from "../../types";

/**
 * Warehouse compute driven by apps, one row per caller identity, covering
 * both modes: on-behalf-of (audit identity chain — databrickssql.commandSubmit
 * acting_resource + statement id joined to query history) and service
 * principal (query history executed_by, job runs excluded).
 *
 * Allocation is hour-matched: each caller gets that hour's billed warehouse
 * cost × its task-time share of the hour, with the share denominator floored
 * at one compute-hour so seconds of work never absorb an idle hour's bill.
 * Hours where the caller ran nothing contribute zero.
 * Fully out-of-the-box: nothing app-side, permissions untouched.
 *
 * Rows are named automatically from the integration's creation audit event;
 * identities the audit window can't name get an inline name box whose label
 * persists in the app store.
 */
export function OboAttributionCard({
  rows,
  totalUsd,
  error,
  cur,
  onSaved,
}: {
  rows: OboAttributionRow[];
  totalUsd: number;
  error: string | null;
  cur: MoneyCurrency;
  onSaved: () => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function saveLabel(integrationId: string) {
    const name = (drafts[integrationId] ?? "").trim();
    if (!name || savingId) return;
    setSavingId(integrationId);
    setSaveError(null);
    try {
      await saveAppIdentityLabel(integrationId, name);
      await postCacheRefresh("apps_cost").catch(() => undefined);
      onSaved(); // page refetch → polls until the rebuilt payload lands
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div className="card flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold flex items-center gap-1.5">
            Warehouse compute called through apps
            <InfoTip text="On-behalf-of statements are audited with the app's OAuth integration as the acting resource plus the statement id, joined to query history; service-principal statements come from query history directly (job runs excluded). Cost is allocated hour by hour: the caller gets each warehouse-hour's billed cost × its task-time share of that hour (denominator floored at one compute-hour), so hours without app queries contribute zero. OBO rows require verbose audit logging; the user's permissions are untouched." />
          </h3>
          <p className="text-xs text-neutral mt-1">
            Out-of-the-box, hour-matched attribution of shared-warehouse usage driven by apps — both
            on-behalf-of traffic (audit identity chain) and service-principal traffic (query history,
            job runs excluded). SP rows can also be other services' principals — label the ones you
            recognise as apps.
          </p>
        </div>
        <span className="text-xs text-neutral shrink-0">
          MTD total: <span className="font-semibold text-brand-dark tabular-nums">{fmtMoney(totalUsd, cur, { compact: true })}</span>
        </span>
      </div>

      {error && (
        <p className="text-xs text-danger">Attribution unavailable: {error}</p>
      )}
      {!error && rows.length === 0 && (
        <p className="text-xs text-neutral">
          No app-driven warehouse statements found this month. If apps are in use, check that verbose
          audit logging is enabled on the workspace — on-behalf-of attribution reads
          databrickssql.commandSubmit events.
        </p>
      )}
      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-neutral border-b border-border">
                <th className="py-1.5 px-3 font-medium">App</th>
                <th className="py-1.5 pr-3 font-medium">Mode</th>
                <th className="py-1.5 pr-3 font-medium">Caller identity</th>
                <th className="py-1.5 pr-3 font-medium text-right">Warehouse $ (MTD)</th>
                <th className="py-1.5 pr-3 font-medium text-right">Statements</th>
                <th className="py-1.5 pr-3 font-medium text-right">Users</th>
                <th className="py-1.5 pr-3 font-medium">Warehouses</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.integration_id} className="border-b border-border/50">
                  <td className="py-1.5 px-3">
                    {r.name ? (
                      <span className="inline-flex items-center gap-1.5">
                        <span className="font-medium">{r.name}</span>
                        {r.name_source === "audit" && (
                          <span className="pill bg-border/40 text-neutral" title="Named automatically from the integration's creation audit event.">auto</span>
                        )}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5">
                        <input
                          type="text"
                          placeholder="Name this app…"
                          value={drafts[r.integration_id] ?? ""}
                          onChange={(e) => setDrafts((d) => ({ ...d, [r.integration_id]: e.target.value }))}
                          onKeyDown={(e) => e.key === "Enter" && void saveLabel(r.integration_id)}
                          className="w-40 rounded-lg border border-border bg-surface px-2 py-1 text-xs focus:outline-none focus:border-accent"
                        />
                        <button
                          type="button"
                          onClick={() => void saveLabel(r.integration_id)}
                          disabled={savingId !== null || !(drafts[r.integration_id] ?? "").trim()}
                          className="px-2 py-1 rounded-lg border border-border text-[11px] text-neutral hover:text-brand-dark hover:bg-surface transition disabled:opacity-50"
                        >
                          {savingId === r.integration_id ? "Saving…" : "Save"}
                        </button>
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 pr-3">
                    <span className={`pill ${r.kind === "obo" ? "bg-info/15 text-info" : "bg-border/60 text-neutral"}`}
                      title={r.kind === "obo"
                        ? "On-behalf-of: users' statements submitted through the app (OAuth integration identity)."
                        : "Service principal: statements the identity ran itself (M2M) — may also be a non-app service."}>
                      {r.kind === "obo" ? "on-behalf-of" : "service principal"}
                    </span>
                  </td>
                  <td className="py-1.5 pr-3 font-mono text-neutral" title={r.integration_id}>
                    {r.integration_id.slice(0, 8)}…
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums font-medium">{fmtMoney(r.usd, cur, { compact: true })}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums text-neutral">{fmtNum(r.statements)}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums text-neutral">{r.kind === "sp" ? "—" : fmtNum(r.users)}</td>
                  <td className="py-1.5 pr-3 font-mono text-neutral truncate max-w-[220px]">{r.warehouses.join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {saveError && <p className="text-xs text-danger">{saveError}</p>}
      <p className="text-[11px] text-neutral">
        Allocation basis, per warehouse-hour: that hour's billed cost × the caller's task-time ÷ the
        hour's total task-time (floored at one compute-hour). Idle hours stay unattributed. Unnamed
        rows are identities the audit window can't name — label them once and the name sticks.
      </p>
    </div>
  );
}
