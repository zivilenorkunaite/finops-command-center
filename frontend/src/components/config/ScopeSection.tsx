import { useEffect, useMemo, useState } from "react";
import { fetchAdminWorkspaces, refreshAdminWorkspaces, saveAdminWorkspaces } from "../../api/client";
import { LoadingCard, ErrorCard } from "../layout/PageShell";
import { fmtMoney } from "../shared/format";
import { useCurrency } from "../../store/appStore";
import type { AdminWorkspacesResponse } from "../../types";

// ---------------------------------------------------------------------------

export function ScopeSection() {
  const cur = useCurrency();
  const [ws, setWs] = useState<AdminWorkspacesResponse | null>(null);
  const [wsError, setWsError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    fetchAdminWorkspaces()
      .then((r) => {
        setWs(r);
        setSelected(new Set(r.data.filter((w) => w.included).map((w) => w.workspace_id)));
      })
      .catch((e: unknown) => setWsError(e instanceof Error ? e.message : String(e)));
  }, []);

  const all = ws?.data ?? [];
  const visible = useMemo(() => {
    const q = search.trim();
    const matches = q ? all.filter((w) => w.workspace_id.includes(q)) : all;
    return matches.slice(0, 300);
  }, [all, search]);
  const matchCount = useMemo(() => {
    const q = search.trim();
    return q ? all.filter((w) => w.workspace_id.includes(q)).length : all.length;
  }, [all, search]);

  const initialIncluded = useMemo(() => new Set(all.filter((w) => w.included).map((w) => w.workspace_id)), [all]);
  const dirty =
    ws != null &&
    (selected.size !== initialIncluded.size || Array.from(selected).some((id) => !initialIncluded.has(id)));

  function toggle(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setMsg(null);
  }

  async function onRefresh() {
    if (refreshing || saving) return;
    setRefreshing(true);
    setWsError(null);
    setMsg(null);
    try {
      const next = await refreshAdminWorkspaces();
      setWs(next);
      setSelected(new Set(next.data.filter((w) => w.included).map((w) => w.workspace_id)));
      setMsg(`List refreshed — ${next.data.length} workspaces with usage this month.`);
    } catch (e: unknown) {
      setWsError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  }

  async function onSave() {
    if (!ws || saving || selected.size === 0) return;
    setSaving(true);
    setWsError(null);
    setMsg(null);
    try {
      // Selecting everything = no filter: store nothing rather than 3,000 ids.
      const ids = selected.size === all.length ? [] : Array.from(selected);
      const next = await saveAdminWorkspaces(ids);
      setWs(next);
      setSelected(new Set(next.data.filter((w) => w.included).map((w) => w.workspace_id)));
      setMsg(
        next.scope_active
          ? `Saved — ${next.num_included} of ${next.data.length} workspaces included. Caches cleared; pages pick it up on next load.`
          : "Saved — no filter; all workspaces included.",
      );
    } catch (e: unknown) {
      setWsError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card max-w-4xl flex flex-col gap-3">
      <p className="text-xs text-neutral">
        Billing data is account-wide, so this estate spans thousands of workspaces. Tick the workspaces to
        include — <span className="font-medium">every workspace-scoped query</span> (Overview, Workspaces,
        Cost drivers, Genie $, AI $, Query Advisor, Governance, Recommendations) honours the selection.
        Access and Tables are metastore-level and unaffected. Stored by the app and applied for every
        viewer; no selection = all workspaces.
      </p>
      {wsError && <ErrorCard message={wsError} />}
      {!ws && !wsError && <LoadingCard label="Loading the workspace list… (first-ever load builds it from billing and takes a minute)" />}
      {ws && (
        <>
          <div className="flex items-center gap-2 flex-wrap text-xs">
            <span className={`pill ${ws.scope_active ? "bg-accent/10 text-accent" : "bg-border/60 text-neutral"}`}>
              {ws.scope_active ? `scope active · ${ws.num_included} of ${all.length}` : `no filter · all ${all.length}`}
            </span>
            <span className="text-neutral tabular-nums">{selected.size} selected</span>
            <input
              type="search"
              placeholder="Search workspace ID…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="ml-auto w-52 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs focus:outline-none focus:border-accent"
            />
            <button
              type="button"
              onClick={onRefresh}
              disabled={refreshing}
              title="Rebuild the stored workspace list from a fresh month-wide billing scan"
              className="px-2.5 py-1.5 rounded-lg border border-border text-xs text-neutral hover:text-brand-dark hover:bg-surface transition disabled:opacity-60"
            >
              {refreshing ? "Rescanning billing…" : "Refresh list"}
            </button>
            <button
              type="button"
              onClick={() => setSelected(new Set(all.map((w) => w.workspace_id)))}
              className="px-2.5 py-1.5 rounded-lg border border-border text-xs text-neutral hover:text-brand-dark hover:bg-surface transition"
            >
              Select all
            </button>
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="px-2.5 py-1.5 rounded-lg border border-border text-xs text-neutral hover:text-brand-dark hover:bg-surface transition"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={onSave}
              disabled={!dirty || saving || selected.size === 0}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-medium transition ${
                dirty && !saving && selected.size > 0
                  ? "bg-accent text-white hover:opacity-90"
                  : "bg-border text-neutral cursor-not-allowed"
              }`}
            >
              {saving ? "Saving…" : "Save scope"}
            </button>
          </div>
          {selected.size === 0 && (
            <p className="text-xs text-danger">Select at least one workspace (or Select all for no filter).</p>
          )}
          {msg && <p className="text-xs text-success">{msg}</p>}
          <div className="max-h-80 overflow-y-auto rounded-lg border border-border">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-card">
                <tr className="text-left text-neutral border-b border-border">
                  <th className="py-1.5 px-3 font-medium w-8"></th>
                  <th className="py-1.5 pr-3 font-medium">Workspace ID</th>
                  <th className="py-1.5 pr-3 font-medium text-right">Spend / mo</th>
                  <th className="py-1.5 pr-3 font-medium text-right">DBUs / mo</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((w) => (
                  <tr
                    key={w.workspace_id}
                    className="border-b border-border/50 hover:bg-surface cursor-pointer"
                    onClick={() => toggle(w.workspace_id)}
                  >
                    <td className="py-1.5 px-3">
                      <input
                        type="checkbox"
                        checked={selected.has(w.workspace_id)}
                        onChange={() => toggle(w.workspace_id)}
                        onClick={(e) => e.stopPropagation()}
                        aria-label={`Include workspace ${w.workspace_id}`}
                      />
                    </td>
                    <td className="py-1.5 pr-3 font-mono">{w.workspace_id}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{fmtMoney(w.spend_usd_month, cur, { compact: true })}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-neutral">{Math.round(w.dbus_month).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-neutral">
            Sorted by spend. Showing {visible.length} of {matchCount}
            {matchCount > visible.length ? " — search to narrow." : "."}
            {ws.computed_at ? ` Stored list from ${ws.computed_at} — Refresh to rescan billing.` : ""}
          </p>
        </>
      )}
    </div>
  );
}
