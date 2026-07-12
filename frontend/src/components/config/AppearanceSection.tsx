import { useEffect, useState } from "react";
import { fetchConfig } from "../../api/client";
import { useAppStore } from "../../store/appStore";
import type { AppConfig } from "../../types";

// ---------------------------------------------------------------------------

export function AppearanceSection() {
  const dark = useAppStore((s) => s.dark);
  const setDark = useAppStore((s) => s.setDark);
  const [config, setConfig] = useState<AppConfig | null>(null);

  useEffect(() => {
    fetchConfig().then(setConfig).catch(() => setConfig(null));
  }, []);

  const aud = config?.currencies?.find((c) => c.code === "AUD");

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-w-4xl items-start">
      <div className="card flex flex-col gap-3">
        <div>
          <h3 className="text-sm font-semibold">Theme</h3>
          <p className="text-xs text-neutral mt-1">Stored in this browser only — every viewer picks their own.</p>
        </div>
        <div className="inline-flex rounded-lg border border-border overflow-hidden w-fit">
          {[
            { value: true, label: "☾ Dark" },
            { value: false, label: "☀ Light" },
          ].map((opt) => (
            <button
              key={opt.label}
              type="button"
              aria-pressed={dark === opt.value}
              onClick={() => setDark(opt.value)}
              className={`px-4 py-2 text-xs font-medium transition ${
                dark === opt.value ? "bg-accent text-white" : "text-neutral hover:text-brand-dark hover:bg-surface"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="card flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Session &amp; deployment</h3>
        <dl className="text-xs flex flex-col gap-1.5">
          <div className="flex items-baseline gap-2">
            <dt className="text-neutral w-28 shrink-0">Signed in as</dt>
            <dd className="font-mono truncate">{config?.viewer || "—"}</dd>
          </div>
          <div className="flex items-baseline gap-2">
            <dt className="text-neutral w-28 shrink-0">Customer</dt>
            <dd>{config?.customer || "—"}</dd>
          </div>
          <div className="flex items-baseline gap-2">
            <dt className="text-neutral w-28 shrink-0">FX rate</dt>
            <dd className="tabular-nums">{aud ? `1 USD = A$${aud.rate} (deploy-time setting)` : "USD only"}</dd>
          </div>
        </dl>
        <p className="text-[11px] text-neutral border-t border-border pt-2 mt-1">
          Every estate read runs with the signed-in identity's permissions (on-behalf-of-user); cached data
          is kept per viewer. The AUD rate and currency options are deploy-time settings — the USD / AUD
          switch stays in the header.
        </p>
      </div>
    </div>
  );
}
