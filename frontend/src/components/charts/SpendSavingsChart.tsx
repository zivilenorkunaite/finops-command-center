import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { TrendPoint } from "../../types";
import { fmtMoney } from "../shared/format";
import { InfoTip } from "../shared/InfoTip";
import { useCurrency } from "../../store/appStore";

export function SpendSavingsChart({ data }: { data: TrendPoint[] }) {
  const cur = useCurrency();
  // Live mode sends savings_usd: null — realised savings are not measurable
  // from system tables, so the series (and its "captured" framing) is dropped
  // rather than presenting a derived estimate as actuals.
  const hasSavings = data.some((d) => d.savings_usd != null);
  const chartData = data.map((d) => ({
    week: d.week.slice(5), // MM-DD
    spend: d.spend_usd * cur.rate,
    savings: d.savings_usd == null ? null : d.savings_usd * cur.rate,
  }));
  return (
    <div className="card">
      <div className="flex items-baseline justify-between mb-2">
        <h3 className="text-sm font-semibold flex items-center gap-1.5">
          {hasSavings ? "Weekly spend and captured savings" : "Weekly spend"}
          <InfoTip
            text={
              hasSavings
                ? "Weekly spend in dollars alongside savings actually captured to date. Captured savings ramp up as teams act on recommendations."
                : "Weekly platform spend at USD list price, from system.billing.usage."
            }
          />
        </h3>
        <span className="text-xs text-neutral">last 12 weeks</span>
      </div>
      <ResponsiveContainer width="100%" height={260}>
        <AreaChart data={chartData} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
          <defs>
            <linearGradient id="spendGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#FF3621" stopOpacity={0.35} />
              <stop offset="100%" stopColor="#FF3621" stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id="savingsGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#1B8A4A" stopOpacity={0.35} />
              <stop offset="100%" stopColor="#1B8A4A" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--color-border))" vertical={false} />
          <XAxis dataKey="week" tick={{ fontSize: 11, fill: "rgb(var(--color-neutral))" }} axisLine={false} tickLine={false} />
          <YAxis
            tickFormatter={(v) => fmtMoney((v as number) / cur.rate, cur, { compact: true })}
            tick={{ fontSize: 11, fill: "rgb(var(--color-neutral))" }}
            axisLine={false}
            tickLine={false}
            width={52}
          />
          <Tooltip
            contentStyle={{
              background: "rgb(var(--color-card))",
              border: "1px solid rgb(var(--color-border))",
              borderRadius: 8,
              fontSize: 12,
            }}
            labelStyle={{ color: "rgb(var(--color-brand-dark))" }}
            formatter={(value: number, name: string) => [fmtMoney((value as number) / cur.rate, cur), name === "spend" ? "Spend" : "Savings captured"]}
          />
          {hasSavings && (
            <Legend wrapperStyle={{ fontSize: 11 }} formatter={(v) => (v === "spend" ? "Spend" : "Savings captured")} />
          )}
          <Area
            type="monotone"
            dataKey="spend"
            name="spend"
            stroke="#FF3621"
            strokeWidth={2}
            fill="url(#spendGrad)"
            connectNulls
            isAnimationActive={false}
          />
          {hasSavings && (
            <Area
              type="monotone"
              dataKey="savings"
              name="savings"
              stroke="#1B8A4A"
              strokeWidth={2}
              fill="url(#savingsGrad)"
              connectNulls
              isAnimationActive={false}
            />
          )}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
