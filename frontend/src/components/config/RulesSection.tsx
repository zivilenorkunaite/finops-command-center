import { useEffect, useState } from "react";
import { fetchAdminConfig } from "../../api/client";
import { LoadingCard, ErrorCard } from "../layout/PageShell";
import type { AdminConfig } from "../../types";

// ---------------------------------------------------------------------------

export function RulesSection() {
  const [defs, setDefs] = useState<AdminConfig | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    fetchAdminConfig()
      .then(setDefs)
      .catch(() => setFailed(true));
  }, []);

  if (failed) return <ErrorCard message="Could not load the risk-flag definitions." />;
  if (!defs) return <LoadingCard label="Loading definitions…" />;
  if (!defs.risk_definitions) return null;

  return (
    <div className="card max-w-4xl flex flex-col gap-3">
      <p className="text-xs text-neutral">
        Read-only. These are the exact rules the Access page applies to direct Unity Catalog grants —
        deterministic checks computed from system tables, no model involved.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-neutral border-b border-border">
              <th className="py-1.5 pr-3 font-medium">Flag</th>
              <th className="py-1.5 pr-3 font-medium">Severity</th>
              <th className="py-1.5 font-medium">Definition</th>
            </tr>
          </thead>
          <tbody>
            {defs.risk_definitions.flags.map((f) => (
              <tr key={f.flag} className="border-b border-border/50 align-top">
                <td className="py-1.5 pr-3 font-medium whitespace-nowrap">{f.flag}</td>
                <td className="py-1.5 pr-3">
                  <span className={`pill capitalize ${f.severity === "critical" ? "bg-danger/15 text-danger" : "bg-warning/15 text-warning"}`}>
                    {f.severity}
                  </span>
                </td>
                <td className="py-1.5 text-neutral">{f.definition}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="flex flex-col gap-1 text-[11px] text-neutral border-t border-border pt-2">
        {defs.risk_definitions.notes.map((n, i) => (
          <li key={i} className="flex gap-1.5">
            <span className="shrink-0" aria-hidden>
              ·
            </span>
            <span>{n}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
