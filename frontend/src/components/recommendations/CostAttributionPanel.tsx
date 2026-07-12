import type { Attribution } from "../../types";
import { fmtMoney, fmtPct } from "../shared/format";
import { useCurrency } from "../../store/appStore";
import { GenieSpendCard } from "../genie/GenieSpendCard";
import { InfoTip } from "../shared/InfoTip";

// Cost-attribution panel: tagging coverage per workspace, spend by cost
// driver and month-over-month driver spikes. Every figure comes from the
// same cached objects the Governance and Overview tabs show, so the numbers
// always agree across tabs.
export function CostAttributionPanel({ attribution, workspace }: { attribution: Attribution; workspace?: string }) {
  const cur = useCurrency();
  const byWs = attribution.by_workspace.slice(0, 8);
  const maxWs = Math.max(...byWs.map((w) => w.spend_usd_month), 1);
  const topDrivers = attribution.cost_drivers.slice(0, 10);
  const maxDriver = Math.max(...topDrivers.map((d) => d.spend_usd_month), 1);
  const spikes = attribution.driver_spikes ?? [];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold flex items-center gap-1.5">
          Cost attribution
          <InfoTip text="How much spend can be traced back via cost-attribution tags. Untagged spend cannot be charged back and is the gap to close. Same figures as the Governance tab." />
        </h3>
        <span className="text-xs text-neutral tabular-nums">
          {fmtMoney(attribution.total_untagged_usd_month, cur, { compact: true })} untagged ·{" "}
          {fmtPct(attribution.untagged_pct)} of {fmtMoney(attribution.total_spend_usd_month, cur, { compact: true })}
        </span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Spend + tag coverage by workspace */}
        <div className="card flex flex-col gap-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-neutral flex items-center gap-1.5">
            Spend & tag coverage by workspace
            <InfoTip text="Monthly spend per workspace and the share of it carrying cost-attribution tags. Low tagged % means that spend cannot be reliably charged back." />
          </div>
          <div className="flex flex-col gap-2.5">
            {byWs.map((w) => (
              <div key={w.workspace} className="flex flex-col gap-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="truncate mr-2 font-mono">{w.workspace}</span>
                  <span className="tabular-nums text-neutral shrink-0">
                    {fmtMoney(w.spend_usd_month, cur, { compact: true })} ·{" "}
                    <span className={w.tagging_pct >= 0.8 ? "text-success" : w.tagging_pct >= 0.5 ? "text-warning" : "text-danger"}>
                      {fmtPct(w.tagging_pct)} tagged
                    </span>
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-border/60 overflow-hidden">
                  <div className="h-full rounded-full bg-accent" style={{ width: `${(w.spend_usd_month / maxWs) * 100}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Cost by driver (billing_origin_product) */}
        <div className="card flex flex-col gap-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-neutral flex items-center gap-1.5">
            Cost by driver (billing_origin_product)
            <InfoTip text="Spend grouped by the product that generated it — the same breakdown as the Overview tab." />
          </div>
          <div className="flex flex-col gap-2.5">
            {topDrivers.map((d) => (
              <div key={d.driver} className="flex flex-col gap-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="truncate mr-2">{d.label ?? d.driver}</span>
                  <span className="tabular-nums text-neutral shrink-0">
                    {fmtMoney(d.spend_usd_month, cur, { compact: true })} · {fmtPct(d.pct_of_total, 1)}
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-border/60 overflow-hidden">
                  <div className="h-full rounded-full bg-info" style={{ width: `${(d.spend_usd_month / maxDriver) * 100}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* MoM cost-driver spikes */}
      {spikes.length > 0 && (
        <div className="card border-l-4 border-l-warning flex flex-col gap-2 py-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-neutral flex items-center gap-1.5">
            Cost-driver spikes vs prior month
            <InfoTip text="Drivers whose spend jumped more than 25% (and $100) month over month — the first place to look for overruns." />
          </div>
          <div className="flex flex-wrap gap-2">
            {spikes.map((s) => (
              <span key={s.driver} className="pill tabular-nums bg-warning/15 text-warning">
                {s.label} +{fmtPct(s.mom_pct)} MoM · +{fmtMoney(s.delta_usd, cur, { compact: true })}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Genie spend by surface */}
      <GenieSpendCard workspace={workspace} />
    </div>
  );
}
