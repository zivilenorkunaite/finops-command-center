import type { HubRec } from "../../types";

const SCOPE_LABEL: Record<string, string> = {
  global: "Estate-wide",
  workspace: "Workspace",
};

// Expanded rec detail: what-to-do steps, scope and suggested owner — nothing
// that the backend does not actually send.
export function RecCard({ rec }: { rec: HubRec }) {
  return (
    <div className="flex flex-col gap-4 text-sm">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-neutral mb-1.5">What to do</div>
          <ol className="list-decimal list-inside flex flex-col gap-1 text-brand-dark/90">
            {rec.what_to_do.map((step, i) => (
              <li key={i} className="leading-snug">
                {step}
              </li>
            ))}
          </ol>
        </div>

        <div className="grid grid-cols-2 gap-3 content-start">
          <div>
            <div className="text-[11px] uppercase tracking-wide text-neutral">Scope</div>
            <div className="text-brand-dark">
              {SCOPE_LABEL[rec.scope] ?? rec.scope}
              <span className="text-neutral"> · </span>
              <span className="font-mono text-xs">{rec.scope_label}</span>
            </div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide text-neutral">Suggested owner</div>
            <div className="text-brand-dark">{rec.owner || "—"}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
