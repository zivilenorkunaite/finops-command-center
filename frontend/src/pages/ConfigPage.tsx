import { useState } from "react";
import { PageShell } from "../components/layout/PageShell";
import { PagesSection } from "../components/config/PagesSection";
import { CacheSection } from "../components/config/CacheSection";
import { ScopeSection } from "../components/config/ScopeSection";
import { RulesSection } from "../components/config/RulesSection";
import { AppearanceSection } from "../components/config/AppearanceSection";

// ---------------------------------------------------------------------------
// The Configuration page (gear button in the header). Five sections:
//   Pages & data   — what every tab shows and exactly which tables feed it
//   Cached data    — freshness + refresh for every registered cache object
//   Workspace scope— which workspaces every query includes (applies to all)
//   Access rules   — read-only definitions of the Access risk flags
//   Appearance     — theme (per browser) + session / deployment facts
// ---------------------------------------------------------------------------

type SectionId = "pages" | "cache" | "scope" | "rules" | "appearance";

const SECTIONS: { id: SectionId; label: string }[] = [
  { id: "pages", label: "Pages & data" },
  { id: "cache", label: "Cached data" },
  { id: "scope", label: "Workspace scope" },
  { id: "rules", label: "Access rules" },
  { id: "appearance", label: "Appearance" },
];

export function ConfigPage() {
  const [section, setSection] = useState<SectionId>("pages");

  return (
    <PageShell
      title="Configuration"
      subtitle="Operator settings and app documentation — workspace scope and caches apply as described per section; appearance is per browser"
    >
      <div className="inline-flex rounded-lg border border-border overflow-hidden w-fit bg-card" role="tablist" aria-label="Configuration sections">
        {SECTIONS.map((s) => {
          const active = section === s.id;
          return (
            <button
              key={s.id}
              role="tab"
              aria-selected={active}
              type="button"
              onClick={() => setSection(s.id)}
              className={`px-3.5 py-2 text-xs font-medium whitespace-nowrap transition ${
                active ? "bg-accent text-white" : "text-neutral hover:text-brand-dark hover:bg-surface"
              }`}
            >
              {s.label}
            </button>
          );
        })}
      </div>

      {section === "pages" && <PagesSection />}
      {section === "cache" && <CacheSection />}
      {section === "scope" && <ScopeSection />}
      {section === "rules" && <RulesSection />}
      {section === "appearance" && <AppearanceSection />}
    </PageShell>
  );
}
