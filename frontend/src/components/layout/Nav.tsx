import { useAppStore, useFeatures } from "../../store/appStore";
import type { CurrencyOption, PageId } from "../../types";

// The "Data Quality" tab is only present when features.dqm is on —
// it is inserted before Recommendations. All other tabs are always present.
// Configuration is NOT a tab: it opens from the gear button on the right.
const BASE_TABS: { id: PageId; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "access", label: "Access" },
  { id: "workspaces", label: "Workspaces" },
  { id: "queries", label: "Query Advisor" },
  { id: "tables", label: "Tables" },
  { id: "governance", label: "Governance" },
  { id: "tags", label: "Tags" },
];
const ADOPTION_TAB: { id: PageId; label: string } = { id: "adoption", label: "Adoption & Value" };
const GENIE_TAB: { id: PageId; label: string } = { id: "genie", label: "Genie $" };
const AI_TAB: { id: PageId; label: string } = { id: "ai", label: "AI $" };
const APPS_TAB: { id: PageId; label: string } = { id: "apps", label: "Apps $" };
const DQM_TAB: { id: PageId; label: string } = { id: "dqm", label: "Data Quality" };
const RECS_TAB: { id: PageId; label: string } = { id: "recommendations", label: "Recommendations" };

function GearIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function LogoMark() {
  return (
    <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden className="shrink-0">
      <rect width="32" height="32" rx="6" className="fill-surface" />
      <path
        d="M6 20l5-6 4 4 6-8 5 6"
        fill="none"
        stroke="rgb(var(--color-accent))"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Segmented USD / AUD currency toggle. Persists via the store.
function CurrencyToggle({ currencies }: { currencies: CurrencyOption[] }) {
  const { currency, setCurrency } = useAppStore();
  const aud = currencies.find((c) => c.code === "AUD");
  return (
    <div className="inline-flex items-center gap-1.5">
      <div className="inline-flex rounded-lg border border-border overflow-hidden" title="List-price USD × FX rate — indicative AUD conversion">
        {currencies.map((c) => (
          <button
            key={c.code}
            type="button"
            aria-pressed={currency === c.code}
            onClick={() => setCurrency(c.code)}
            className={`px-2.5 py-1 text-xs font-medium transition ${
              currency === c.code ? "bg-accent text-white" : "text-neutral hover:text-brand-dark hover:bg-surface"
            }`}
          >
            {c.code}
          </button>
        ))}
      </div>
      {aud && (
        <span
          className="text-[10px] text-neutral whitespace-nowrap tabular-nums"
          title="Deploy-time rate (customise.yaml fx_aud). AUD figures are USD list price × this rate — indicative, not billed AUD."
        >
          1 USD = A${aud.rate}
        </span>
      )}
    </div>
  );
}

export function Nav({
  currencies,
  viewer,
}: {
  currencies: CurrencyOption[];
  viewer?: string | null;
}) {
  const { activePage, setActivePage } = useAppStore();
  const features = useFeatures();
  const tabs = [...BASE_TABS, ADOPTION_TAB, GENIE_TAB, AI_TAB, APPS_TAB, ...(features.dqm ? [DQM_TAB] : []), RECS_TAB];
  const onConfig = activePage === "admin";
  return (
    <header className="bg-card border-b border-border sticky top-0 z-40">
      <div className="max-w-[1500px] mx-auto px-6 pt-3">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <LogoMark />
            <div>
              <h1 className="text-base font-semibold leading-tight tracking-tight">FinOps Command Center</h1>
              <p className="text-[11px] text-neutral leading-tight">Databricks-native cost-control co-pilot · Energy for All</p>
            </div>
          </div>
          <div className="flex items-center gap-2.5">
            {viewer && (
              <span
                className="text-[11px] text-neutral font-mono truncate max-w-[220px]"
                title="Signed-in viewer — every estate read runs with this identity's permissions (on-behalf-of-user), and cached data is kept per user."
              >
                {viewer}
              </span>
            )}
            <CurrencyToggle currencies={currencies} />
            <button
              type="button"
              onClick={() => setActivePage("admin")}
              title="Configuration — workspace scope, cached data, page guide, access rules, appearance"
              aria-label="Open configuration"
              aria-pressed={onConfig}
              className={`flex items-center justify-center h-8 w-8 rounded-lg border transition ${
                onConfig
                  ? "border-accent bg-accent/10 text-accent"
                  : "border-border text-neutral hover:text-brand-dark hover:bg-surface"
              }`}
            >
              <GearIcon />
            </button>
          </div>
        </div>
        {/* One row, always: 14 tabs fit via smaller text + tighter padding
            (overflow-x-auto only as a very-narrow-screen fallback). */}
        <nav className="flex items-center gap-x-0.5 mt-2 -mb-px overflow-x-auto" role="tablist">
          {tabs.map((tab) => {
            const active = activePage === tab.id;
            return (
              <button
                key={tab.id}
                role="tab"
                aria-selected={active}
                type="button"
                onClick={() => setActivePage(tab.id)}
                className={
                  "px-2.5 py-2 text-[13px] font-medium whitespace-nowrap border-b-2 transition " +
                  (active
                    ? "border-accent text-brand-dark"
                    : "border-transparent text-neutral hover:text-brand-dark")
                }
              >
                {tab.label}
              </button>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
