import { useEffect, useMemo, useState } from "react";
import { fetchCacheStatus, postCacheRefresh } from "../../api/client";
import { LoadingCard, ErrorCard } from "../layout/PageShell";
import { InfoTip } from "../shared/InfoTip";
import type { CacheStatusEntry } from "../../types";

function fmtCacheAge(seconds: number | null): string {
  if (seconds == null) return "never";
  if (seconds < 90) return "just now";
  if (seconds < 5400) return `${Math.round(seconds / 60)} min ago`;
  return `${(seconds / 3600).toFixed(1)} h ago`;
}

// ---------------------------------------------------------------------------

export function CacheSection() {
  const [entries, setEntries] = useState<CacheStatusEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchCacheStatus()
      .then((r) => {
        if (!cancelled) {
          setEntries(r.data);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  // Keep polling while any object is refreshing.
  useEffect(() => {
    if (!entries?.some((e) => e.refreshing)) return;
    const t = setTimeout(() => setTick((n) => n + 1), 8000);
    return () => clearTimeout(t);
  }, [entries]);

  async function onRefresh(objectId: string) {
    setBusy(objectId);
    try {
      const r = await postCacheRefresh(objectId);
      setEntries(r.data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const groups = useMemo(() => {
    const out = new Map<string, CacheStatusEntry[]>();
    for (const e of entries ?? []) {
      const arr = out.get(e.tab) ?? [];
      arr.push(e);
      out.set(e.tab, arr);
    }
    return Array.from(out.entries());
  }, [entries]);

  return (
    <div className="flex flex-col gap-3">
      <div className="card">
        <p className="text-xs text-neutral">
          Every page is served from these cached objects (TTL ~24 h; stored in the app's own store, so they
          survive restarts). Objects marked <span className="pill bg-info/15 text-info">per user</span> are
          computed on-behalf-of-user and cached separately for each viewer — permissions are never shared
          across people, and the freshness shown here is <span className="font-medium">your</span> copy. A{" "}
          <span className="pill bg-border/60 text-neutral">shared</span> object would be computed with the
          app's own credentials and served to everyone. A stale object keeps serving its existing data while
          a background refresh rebuilds it; Refresh forces that now (same button on each page).
        </p>
      </div>
      {error && <ErrorCard message={error} />}
      {!entries && !error && <LoadingCard label="Loading cache status…" />}
      {entries && (
        <div className="columns-1 lg:columns-2 gap-3 [&>*]:break-inside-avoid">
          {groups.map(([tab, list]) => (
            <div key={tab} className="card mb-3 flex flex-col gap-2">
              <div className="text-[11px] uppercase tracking-wide text-neutral">{tab}</div>
              <div className="flex flex-col divide-y divide-border/50 rounded-lg border border-border">
                {list.map((e) => {
                  const stale = e.age_seconds != null && e.age_seconds > e.ttl_seconds;
                  return (
                    <div key={e.object} className="flex items-center gap-3 px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <span className="text-xs font-medium inline-flex items-center gap-1.5">
                          {e.label}
                          <InfoTip text={`Refresh recomputes: ${e.queries}`} label={`What does ${e.label} query?`} />
                          {e.scope === "user" ? (
                            <span className="pill bg-info/15 text-info" title="Computed on-behalf-of-user — each viewer has their own cached copy; this row is yours.">per user</span>
                          ) : (
                            <span className="pill bg-border/60 text-neutral" title="Computed with the app's own credentials — one copy shared by all viewers.">shared</span>
                          )}
                        </span>
                        <div className="text-[11px] text-neutral tabular-nums">
                          {e.computed_at ? `updated ${fmtCacheAge(e.age_seconds)}` : "not built yet"}
                          {e.error ? " · last refresh failed" : ""}
                        </div>
                      </div>
                      {e.refreshing ? (
                        <span className="pill bg-info/15 text-info animate-pulse">refreshing…</span>
                      ) : e.error ? (
                        <span className="pill bg-danger/15 text-danger" title={e.error}>error</span>
                      ) : stale ? (
                        <span className="pill bg-warning/15 text-warning">stale</span>
                      ) : e.computed_at ? (
                        <span className="pill bg-success/15 text-success">fresh</span>
                      ) : (
                        <span className="pill bg-border/60 text-neutral">empty</span>
                      )}
                      <button
                        type="button"
                        onClick={() => onRefresh(e.object)}
                        disabled={e.refreshing || busy === e.object}
                        className="px-2.5 py-1 rounded-lg border border-border text-xs text-neutral hover:text-brand-dark hover:bg-surface transition disabled:opacity-50"
                      >
                        {busy === e.object ? "Starting…" : "Refresh"}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
