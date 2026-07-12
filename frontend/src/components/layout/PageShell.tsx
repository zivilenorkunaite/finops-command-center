import type { ReactNode } from "react";
import type { CacheMeta, PageId } from "../../types";
import { tablesForPage } from "../../lib/pagesGuide";

function fmtAge(seconds: number | null): string {
  if (seconds == null) return "—";
  if (seconds < 90) return "just now";
  if (seconds < 5400) return `${Math.round(seconds / 60)} min ago`;
  return `${(seconds / 3600).toFixed(1)} h ago`;
}

// "Data as of … · Refresh" badge for pages served from a cache object. Shows
// the background-refresh state; the button kicks an explicit rebuild.
export function CacheBadge({ meta, onRefresh }: { meta: CacheMeta; onRefresh: () => void }) {
  return (
    <span className="inline-flex items-center gap-2 text-[11px] text-neutral">
      <span className="tabular-nums" title={meta.computed_at ? `Computed ${meta.computed_at} · cached ~${Math.round(meta.ttl_seconds / 3600)}h` : ""}>
        Data as of {fmtAge(meta.age_seconds)}
      </span>
      {meta.refreshing ? (
        <span className="pill bg-info/15 text-info animate-pulse">refreshing…</span>
      ) : (
        <button
          type="button"
          onClick={onRefresh}
          title="Rebuild this page's data in the background (the current data stays visible meanwhile)"
          className="pill bg-border/40 text-neutral hover:text-brand-dark transition"
        >
          ⟳ Refresh
        </button>
      )}
      {meta.error && (
        <span className="pill bg-danger/15 text-danger" title={meta.error}>last refresh failed</span>
      )}
    </span>
  );
}

export function PageShell({
  title,
  subtitle,
  cache,
  onRefresh,
  children,
}: {
  title: string;
  subtitle?: string;
  cache?: CacheMeta | null;
  onRefresh?: () => void;
  children: ReactNode;
}) {
  return (
    <div className="max-w-[1500px] mx-auto px-6 py-6 flex flex-col gap-5">
      <div>
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
          {cache && onRefresh && <CacheBadge meta={cache} onRefresh={onRefresh} />}
        </div>
        {subtitle && <p className="text-sm text-neutral mt-0.5">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

export function LoadingCard({ label = "Loading…" }: { label?: string }) {
  return <div className="card text-sm text-neutral py-8 text-center">{label}</div>;
}

export function ErrorCard({ message }: { message: string }) {
  return (
    <div className="card border-l-4 border-l-danger text-sm">
      <span className="text-danger font-medium">Error</span>
      <span className="text-neutral ml-2">{message}</span>
    </div>
  );
}

// Data-fetch failure card for a page: keeps the layout and lists exactly the
// tables the page reads (from the shared pages guide) — the usual cause is a
// missing SELECT grant, and the fix should be spelled out where it fails.
export function PageDataError({ pageId, message }: { pageId: PageId; message: string }) {
  const tables = tablesForPage(pageId);
  return (
    <div className="card border-l-4 border-l-danger flex flex-col gap-2">
      <div className="text-sm">
        <span className="text-danger font-medium">Couldn't read this page's data.</span>
        <span className="text-neutral ml-2">{message}</span>
      </div>
      {tables.length > 0 && (
        <>
          <p className="text-xs text-neutral">
            This page reads the tables below with <span className="font-medium">your</span> permissions.
            If one is named in the error above, ask an admin to grant SELECT on it (grant list in
            docs/DEPLOYMENT.md; per-page overview under Configuration → Pages &amp; data):
          </p>
          <div className="flex flex-wrap gap-1.5">
            {tables.map((t) => (
              <span key={t} className="pill bg-surface border border-border/70 text-neutral font-mono text-[10px]">
                {t}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
