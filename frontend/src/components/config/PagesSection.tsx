import { useAppStore, useFeatures } from "../../store/appStore";
import { TAB_GUIDE } from "../../lib/pagesGuide";

// ---------------------------------------------------------------------------

export function PagesSection() {
  const setActivePage = useAppStore((s) => s.setActivePage);
  const features = useFeatures();
  const guides = TAB_GUIDE.filter((g) => g.id !== "dqm" || features.dqm);

  return (
    <div className="flex flex-col gap-3">
      <div className="card">
        <p className="text-xs text-neutral">
          What every tab shows and exactly which tables feed it. All estate data is read{" "}
          <span className="font-medium text-brand-dark">on-behalf-of the signed-in viewer</span> over the
          configured SQL warehouse — the app never uses its own credentials for estate reads, so every page
          reflects your permissions. App state (workspace scope, the query mirror, caches) lives in the
          app's own store, separate from your data.
        </p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {guides.map((g) => (
          <div key={g.id} className="card flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">{g.label}</h3>
              <button
                type="button"
                onClick={() => setActivePage(g.id)}
                className="pill bg-border/40 text-neutral hover:text-brand-dark transition shrink-0"
                title={`Open the ${g.label} page`}
              >
                open →
              </button>
            </div>
            <p className="text-xs text-neutral leading-relaxed flex-1">{g.description}</p>
            {g.tables.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1 border-t border-border/60">
                {g.tables.map((t) => (
                  <span key={t} className="pill bg-surface border border-border/70 text-neutral font-mono text-[10px]">
                    {t}
                  </span>
                ))}
              </div>
            )}
            {g.note && <p className="text-[11px] text-neutral italic">{g.note}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}
