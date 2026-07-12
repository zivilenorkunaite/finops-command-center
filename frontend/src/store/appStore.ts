import { create } from "zustand";
import type { CurrencyOption, Features, PageId } from "../types";

// Default flags used before /api/config resolves. Genie + DQM default on;
// ai_narration off — matches the backend default contract (data/config.py).
const DEFAULT_FEATURES: Features = { genie: true, ai_narration: false, dqm: true };

// Dual-currency. USD is the source-of-truth list price; AUD is an
// indicative conversion at a configurable FX rate. The selection persists in
// localStorage so it survives reloads and applies across every page.
const CURRENCY_KEY = "finops-currency";
const DEFAULT_CURRENCIES: CurrencyOption[] = [
  { code: "USD", symbol: "$", rate: 1.0, label: "USD (list price)" },
  { code: "AUD", symbol: "A$", rate: 1.52, label: "AUD (× FX)" },
];

function initialCurrency(): string {
  try {
    return localStorage.getItem(CURRENCY_KEY) || "USD";
  } catch {
    return "USD";
  }
}

// Theme lives in the store (toggled from the Configuration page, applied
// app-wide). Persists per browser under the same "theme" key as before.
const THEME_KEY = "theme";

function applyDark(dark: boolean): boolean {
  document.documentElement.classList.toggle("dark", dark);
  try {
    localStorage.setItem(THEME_KEY, dark ? "dark" : "light");
  } catch {
    /* ignore */
  }
  return dark;
}

function initialDark(): boolean {
  let dark = true; // dark default
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored) dark = stored === "dark";
  } catch {
    /* ignore */
  }
  return applyDark(dark);
}

interface AppState {
  activePage: PageId;
  setActivePage: (page: PageId) => void;
  // global filters shared across pages
  workspace: string;
  setWorkspace: (w: string) => void;
  timeRange: string;
  setTimeRange: (t: string) => void;
  // currency toggle (persists)
  currency: string;
  currencies: CurrencyOption[];
  setCurrency: (c: string) => void;
  setCurrencies: (cs: CurrencyOption[]) => void;
  // deploy-time feature flags — set once from /api/config
  features: Features;
  setFeatures: (f: Features) => void;
  // theme (persists per browser; toggled on the Configuration page)
  dark: boolean;
  setDark: (dark: boolean) => void;
}

export const useAppStore = create<AppState>((set) => ({
  activePage: "overview",
  setActivePage: (page) => set({ activePage: page }),
  workspace: "all",
  setWorkspace: (w) => set({ workspace: w }),
  timeRange: "30d",
  setTimeRange: (t) => set({ timeRange: t }),
  currency: initialCurrency(),
  currencies: DEFAULT_CURRENCIES,
  setCurrency: (c) => {
    try {
      localStorage.setItem(CURRENCY_KEY, c);
    } catch {
      /* ignore */
    }
    set({ currency: c });
  },
  setCurrencies: (cs) => set({ currencies: cs.length ? cs : DEFAULT_CURRENCIES }),
  features: DEFAULT_FEATURES,
  setFeatures: (f) => set({ features: f }),
  dark: initialDark(),
  setDark: (dark) => set({ dark: applyDark(dark) }),
}));

// Convenience hook: the resolved feature flags.
export function useFeatures(): Features {
  return useAppStore((s) => s.features);
}

// Convenience hook: returns the active currency option + a USD→display formatter.
export function useCurrency() {
  const currency = useAppStore((s) => s.currency);
  const currencies = useAppStore((s) => s.currencies);
  const opt = currencies.find((c) => c.code === currency) ?? currencies[0] ?? DEFAULT_CURRENCIES[0];
  return opt;
}
