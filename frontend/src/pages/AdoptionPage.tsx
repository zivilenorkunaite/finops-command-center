import {
  CartesianGrid,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { fetchAdoption } from "../api/client";
import { useCachedApi } from "../hooks/useCachedApi";
import { PageShell, LoadingCard, PageDataError } from "../components/layout/PageShell";
import { KpiCard } from "../components/kpi/KpiCard";
import { KpiRow } from "../components/kpi/KpiRow";
import { InfoTip } from "../components/shared/InfoTip";
import { fmtNum } from "../components/shared/format";
import type { ValueMapPoint } from "../types";

const CLASS_COLOR: Record<ValueMapPoint["class"], string> = {
  gold: "#D4A017",
  standard: "#7C6FF0",
  archive: "#E5484D",
};

// Adoption & value — every figure measured: identities from billing +
// query history, product adoption from billing_origin_product, value map
// from real lineage reads × information_schema freshness.
export function AdoptionPage() {
  const { data, loading, error, cache, refresh } = useCachedApi(() => fetchAdoption(), []);
  const d = data?.data;

  return (
    <PageShell
      title="Adoption & value"
      subtitle="Who actually uses the platform and how broadly — active users, activity, product adoption, and which data assets earn their keep. All measured."
      cache={cache}
      onRefresh={refresh}
    >
      {loading && !data && <LoadingCard label="Measuring adoption (billing + query history + lineage)…" />}
      {error && <PageDataError pageId="adoption" message={error} />}
      {d && (
        <>
          <KpiRow cols={6}>
            <KpiCard label="Monthly active users" value={fmtNum(d.mau)} tone="accent" hint="last 30 days" info="Distinct identities with any billed activity (billing run_as) or executed queries (query history) in the last 30 days, within the workspace scope." />
            <KpiCard label="Weekly active" value={fmtNum(d.wau)} tone="info" hint={d.mau ? `${Math.round((d.wau / d.mau) * 100)}% of MAU` : ""} info="Of the monthly active identities, how many were active in the last 7 days. A low share means usage concentrates in few, infrequent sessions." />
            <KpiCard label="Queries / mo" value={fmtNum(d.queries_month, { compact: true })} tone="neutral" info="Statements executed on SQL warehouses in the last 30 days (system.query.history), within the workspace scope." />
            <KpiCard label="Product breadth" value={`${d.feature_breadth_avg}`} hint={`of ${d.num_products} products`} tone="info" info="Average number of distinct billed products (billing_origin_product) per workspace over 30 days, against every product seen in the scope. Broader adoption means the platform is more than a SQL endpoint." />
            <KpiCard label="Genie adopters" value={fmtNum(d.genie_adopters)} tone="success" hint="30d, billed" info="Distinct identities with billed GENIE usage in the last 30 days." />
            <KpiCard label="AI adopters" value={fmtNum(d.ai_adopters)} tone="success" hint="serving · AI functions · vector search" info="Distinct identities with billed usage of AI products (model serving, AI functions, vector search, agents, AI gateway) in the last 30 days." />
          </KpiRow>

          {/* Value map */}
          <div className="card flex flex-col gap-2">
            <div className="flex items-baseline justify-between flex-wrap gap-2">
              <h3 className="text-sm font-semibold flex items-center gap-1.5">
                Value map — tables by usage &amp; freshness
                <InfoTip text="Each point is a table: x = days since it was last altered (information_schema), y = read events in the last 30 days (system.access.table_lineage). Gold = read in the window and in the top quartile of reads. Archive candidate = zero reads and untouched for 30+ days. Standard = everything else." />
              </h3>
              <span className="text-xs flex items-center gap-3">
                {(["gold", "standard", "archive"] as const).map((c) => (
                  <span key={c} className="flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: CLASS_COLOR[c] }} />
                    <span className="text-neutral">{c === "gold" ? "Gold asset" : c === "standard" ? "Standard" : "Archive candidate"}</span>
                  </span>
                ))}
              </span>
            </div>
            {d.value_map.length === 0 ? (
              <p className="text-xs text-neutral">
                No lineage data available — the value map needs SELECT on system.access.table_lineage.
              </p>
            ) : (
              <>
                <ResponsiveContainer width="100%" height={260}>
                  <ScatterChart margin={{ top: 8, right: 16, left: 8, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--color-border))" />
                    <XAxis
                      type="number"
                      dataKey="days_since_update"
                      name="days since update"
                      tick={{ fontSize: 11, fill: "rgb(var(--color-neutral))" }}
                      axisLine={false}
                      tickLine={false}
                      label={{ value: "← fresher · days since update · staler →", position: "insideBottom", offset: -2, fontSize: 11, fill: "rgb(var(--color-neutral))" }}
                    />
                    <YAxis
                      type="number"
                      dataKey="reads_30d"
                      name="reads (30d)"
                      tick={{ fontSize: 11, fill: "rgb(var(--color-neutral))" }}
                      axisLine={false}
                      tickLine={false}
                      width={56}
                    />
                    <Tooltip
                      cursor={{ strokeDasharray: "3 3" }}
                      contentStyle={{ background: "rgb(var(--color-card))", border: "1px solid rgb(var(--color-border))", borderRadius: 8, fontSize: 12 }}
                      formatter={(value, name) => [fmtNum(value as number), name]}
                      labelFormatter={() => ""}
                      content={({ payload }) => {
                        const p = payload?.[0]?.payload as ValueMapPoint | undefined;
                        if (!p) return null;
                        return (
                          <div className="rounded-lg border border-border bg-card px-3 py-2 text-xs">
                            <div className="font-mono">{p.fqn}</div>
                            <div className="text-neutral">{fmtNum(p.reads_30d)} reads (30d) · updated {p.days_since_update}d ago · {p.class}</div>
                          </div>
                        );
                      }}
                    />
                    {(["gold", "standard", "archive"] as const).map((c) => (
                      <Scatter key={c} data={d.value_map.filter((v) => v.class === c)} fill={CLASS_COLOR[c]} isAnimationActive={false} />
                    ))}
                  </ScatterChart>
                </ResponsiveContainer>
                <p className="text-[11px] text-neutral">
                  <span className="text-warning font-medium">{d.num_gold} gold assets</span> (read in-window, top quartile) ·{" "}
                  <span className="text-danger font-medium">{d.num_archive} archive candidates</span> (zero reads, untouched 30+ days).
                  Showing the {d.value_map.length} most-read base tables; views and HMS excluded.
                </p>
              </>
            )}
          </div>

          {/* Feature adoption by workspace */}
          <div className="card flex flex-col gap-3">
            <h3 className="text-sm font-semibold flex items-center gap-1.5">
              Product adoption by workspace
              <InfoTip text="Distinct billed products per workspace over the last 30 days (billing_origin_product), largest DBU consumers first." />
            </h3>
            <div className="flex flex-col gap-2">
              {d.feature_matrix.map((row) => (
                <div key={row.workspace} className="flex items-center gap-3 flex-wrap">
                  <span className="font-mono text-xs w-40 shrink-0">{row.workspace}</span>
                  <span className="text-xs text-neutral tabular-nums w-10">{row.breadth}/{d.num_products}</span>
                  <span className="flex flex-wrap gap-1.5">
                    {row.products.map((p) => (
                      <span key={p.product} className="pill bg-accent/10 text-accent" title={`${fmtNum(p.dbus)} DBUs (30d)`}>
                        {p.product.replaceAll("_", " ")}
                      </span>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Most active users */}
          <div className="card flex flex-col gap-3">
            <h3 className="text-sm font-semibold flex items-center gap-1.5">
              Most active users
              <InfoTip text="Top identities by statements executed in the last 30 days (system.query.history), with their busiest workspace and last activity." />
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-neutral border-b border-border">
                    <th className="py-1.5 pr-3 font-medium">User</th>
                    <th className="py-1.5 pr-3 font-medium">Workspace</th>
                    <th className="py-1.5 pr-3 font-medium text-right">Queries (30d)</th>
                    <th className="py-1.5 font-medium text-right">Last active</th>
                  </tr>
                </thead>
                <tbody>
                  {d.top_users.map((u) => (
                    <tr key={u.user} className="border-b border-border/50">
                      <td className="py-1.5 pr-3 font-mono text-brand-dark">{u.user}</td>
                      <td className="py-1.5 pr-3 font-mono text-neutral">{u.workspace}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{u.queries_30d.toLocaleString()}</td>
                      <td className="py-1.5 text-right tabular-nums text-neutral">{u.last_active}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </PageShell>
  );
}
