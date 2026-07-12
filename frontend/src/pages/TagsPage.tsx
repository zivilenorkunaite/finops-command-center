import { useEffect, useMemo, useState } from "react";
import { fetchTags, saveTagExclusions } from "../api/client";
import { useCachedApi } from "../hooks/useCachedApi";
import { PageShell, LoadingCard, ErrorCard, PageDataError } from "../components/layout/PageShell";
import { DataTable } from "../components/shared/DataTable";
import type { Column } from "../components/shared/DataTable";
import { KpiCard } from "../components/kpi/KpiCard";
import { KpiRow } from "../components/kpi/KpiRow";
import { InfoTip } from "../components/shared/InfoTip";
import { ProgressBar } from "../components/shared/ProgressBar";
import { SearchBox } from "../components/shared/FilterBar";
import { fmtMoney, fmtNum, fmtPct } from "../components/shared/format";
import { useCurrency } from "../store/appStore";
import type { MoneyCurrency } from "../components/shared/format";
import { TagExplorer } from "../components/tags/TagExplorer";
import type { TagKeyRow, TagProductCoverage, TagsReport } from "../types";

export function TagsPage() {
  const cur = useCurrency();
  const [search, setSearch] = useState("");
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Optimistic exclusion set: the SERVER-CONFIRMED keys from the last save.
  // The cached payload lags a save by a full rebuild (~1 min), so pills,
  // sorting and follow-up toggles must read from here — building the next
  // set from the stale payload silently reverts the previous click.
  const [localKeys, setLocalKeys] = useState<string[] | null>(null);
  const { data, loading, error, cache, refresh } = useCachedApi(() => fetchTags(), []);
  const d: TagsReport | undefined = data?.data;

  const effectiveExcluded = localKeys ?? d?.excluded_keys ?? [];
  const isExcluded = (key: string) => effectiveExcluded.includes(key);
  // Numbers are stale until the rebuilt payload agrees with the saved set.
  const recomputing =
    localKeys != null &&
    d != null &&
    JSON.stringify([...localKeys].sort()) !== JSON.stringify([...d.excluded_keys].sort());

  // Once the fresh payload reflects the saved set, drop the overlay.
  useEffect(() => {
    if (localKeys != null && d != null &&
        JSON.stringify([...localKeys].sort()) === JSON.stringify([...d.excluded_keys].sort())) {
      setLocalKeys(null);
    }
  }, [d, localKeys]);

  async function toggleExcluded(row: TagKeyRow) {
    if (!d || savingKey) return;
    setSavingKey(row.key);
    setSaveError(null);
    const next = isExcluded(row.key)
      ? effectiveExcluded.filter((k) => k !== row.key)
      : [...effectiveExcluded, row.key];
    try {
      const res = await saveTagExclusions(next);
      setLocalKeys(res.keys); // pills flip immediately from the confirmed set
      refresh(); // numbers rebuild in the background (badge shows refreshing)
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingKey(null);
    }
  }

  const keys = useMemo(() => {
    const all = d?.keys ?? [];
    const q = search.trim().toLowerCase();
    return q ? all.filter((k) => k.key.toLowerCase().includes(q)) : all;
  }, [d, search]);

  const keyColumns: Column<TagKeyRow>[] = [
    {
      key: "key",
      header: "Tag key",
      sortValue: (r) => r.key,
      render: (r) => <span className="text-xs font-mono truncate">{r.key}</span>,
    },
    {
      key: "coverage",
      header: (
        <span className="inline-flex items-center gap-1">
          Coverage
          <InfoTip text="Share of ALL month-to-date spend whose usage rows carry this key. A key covering most of the estate is usually a workspace-default or platform-injected blanket tag, not deliberate attribution." />
        </span>
      ),
      align: "right",
      sortValue: (r) => r.pct_of_spend,
      render: (r) => (
        <span className={`tabular-nums text-xs ${r.pct_of_spend >= 0.5 ? "text-warning font-medium" : "text-neutral"}`}>
          {r.pct_of_spend ? fmtPct(r.pct_of_spend) : "—"}
        </span>
      ),
    },
    {
      key: "usd",
      header: (
        <span className="inline-flex items-center gap-1">
          Spend carrying it
          <InfoTip text="Month-to-date list-price cost of usage rows carrying this key. A row with several tags counts fully under each of its keys, so these columns don't sum to total spend." />
        </span>
      ),
      align: "right",
      sortValue: (r) => r.usd,
      render: (r) => <span className="tabular-nums text-xs">{r.usd ? fmtMoney(r.usd, cur, { compact: true }) : "—"}</span>,
    },
    {
      key: "values",
      header: "~Values",
      align: "right",
      sortValue: (r) => r.num_values,
      render: (r) => <span className="tabular-nums text-xs text-neutral">{r.num_values ? fmtNum(r.num_values, { compact: true }) : "—"}</span>,
    },
    {
      key: "securables",
      header: (
        <span className="inline-flex items-center gap-1">
          Securables
          <InfoTip text="Unity Catalog objects (catalogs, schemas, tables, columns, volumes) carrying this tag, from the information_schema *_tags views — the ones you can see." />
        </span>
      ),
      align: "right",
      sortValue: (r) => r.securables,
      render: (r) => <span className="tabular-nums text-xs text-neutral">{r.securables || "—"}</span>,
    },
    {
      key: "counted",
      header: (
        <span className="inline-flex items-center gap-1">
          Counted
          <InfoTip text="Whether this key counts toward tagging coverage. Excluding a blanket key (applies for every viewer) recomputes the Tags, Governance, workspace-check and hub tagging figures without it — spend carrying only excluded keys reads as untagged." />
        </span>
      ),
      align: "center",
      sortValue: (r) => (isExcluded(r.key) ? 0 : 1),
      render: (r) => (
        <span className="inline-flex items-center gap-1.5">
          {isExcluded(r.key) && <span className="pill bg-warning/15 text-warning">excluded</span>}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); void toggleExcluded(r); }}
            disabled={savingKey !== null}
            className="px-2 py-0.5 rounded-lg border border-border text-[11px] text-neutral hover:text-brand-dark hover:bg-surface transition disabled:opacity-50"
          >
            {savingKey === r.key ? "Saving…" : isExcluded(r.key) ? "Include" : "Exclude"}
          </button>
        </span>
      ),
    },
  ];

  const covColumns: Column<TagProductCoverage>[] = [
    {
      key: "product",
      header: "Product",
      sortValue: (r) => r.product,
      render: (r) => <span className="text-xs">{r.product}</span>,
    },
    {
      key: "usd",
      header: "Spend / mo",
      align: "right",
      sortValue: (r) => r.usd,
      render: (r) => <span className="tabular-nums text-xs">{fmtMoney(r.usd, cur, { compact: true })}</span>,
    },
    {
      key: "tagged",
      header: "Tagged",
      align: "right",
      sortValue: (r) => r.tagged_usd,
      render: (r) => <span className="tabular-nums text-xs text-neutral">{fmtMoney(r.tagged_usd, cur, { compact: true })}</span>,
    },
    {
      key: "pct",
      header: "Coverage",
      sortValue: (r) => r.tagged_pct,
      render: (r) => (
        <div className="flex items-center gap-2 min-w-[140px]">
          <div className="flex-1">
            <ProgressBar value={r.tagged_pct} tone={r.tagged_pct >= 0.8 ? "success" : r.tagged_pct >= 0.5 ? "warning" : "danger"} showPct={false} />
          </div>
          <span className="tabular-nums text-xs w-10 text-right">{fmtPct(r.tagged_pct)}</span>
        </div>
      ),
    },
  ];

  return (
    <PageShell
      title="Tags"
      subtitle="Tag coverage across billed usage and Unity Catalog — every key in use, and everything a tag is attached to, with its cost"
      cache={cache}
      onRefresh={refresh}
    >
      {loading && !d && <LoadingCard label="Scanning tags across billing usage + Unity Catalog…" />}
      {error && <PageDataError pageId="tags" message={error} />}
      {d && (
        <>
          <KpiRow cols={4}>
            <KpiCard
              label="Tagged spend"
              value={fmtPct(d.tagged_pct)}
              tone={d.tagged_pct >= 0.8 ? "success" : d.tagged_pct >= 0.5 ? "warning" : "danger"}
              hint={`${fmtMoney(d.tagged_usd, cur, { compact: true })} of ${fmtMoney(d.total_usd, cur, { compact: true })} MTD${d.excluded_keys.length ? ` · ${d.excluded_keys.length} key(s) excluded` : ""}`}
              info={`Share of month-to-date list-price spend whose usage rows carry at least one custom tag that counts (system.billing.usage.custom_tags${d.excluded_keys.length ? `; excluded blanket keys: ${d.excluded_keys.join(", ")}` : ""}). The same rule feeds the Governance tile, the per-workspace tagging check and the hub.`}
            />
            <KpiCard
              label="Tag keys in use"
              value={fmtNum(d.distinct_keys_billing)}
              tone="info"
              hint={`+ ${d.distinct_keys_uc} on UC securables`}
              info="Distinct tag keys on billed usage this month. Keys used only on Unity Catalog securables are counted separately in the hint."
            />
            <KpiCard
              label="Untagged spend"
              value={fmtMoney(d.total_usd - d.tagged_usd, cur, { compact: true })}
              tone={d.total_usd - d.tagged_usd > 0 ? "warning" : "success"}
              hint="MTD, no tags at all"
              info="Month-to-date list-price spend whose usage rows carry no custom tags — the part of the bill nobody can attribute."
            />
            <KpiCard
              label="UC tag assignments"
              value={fmtNum(d.uc_total)}
              tone="neutral"
              hint={["catalog", "schema", "table", "column", "volume"].map((l) => `${d.uc_counts[l] ?? 0} ${l}`).join(" · ")}
              info="Tags applied to Unity Catalog securables you can see, from the five information_schema *_tags views."
            />
          </KpiRow>

          {recomputing && (
            <div className="card border-l-4 border-l-info py-2.5">
              <p className="text-xs text-neutral">
                Exclusions saved — coverage on every tab is recomputing in the background; the
                figures below still show the previous rule until the rebuild lands.
              </p>
            </div>
          )}

          {(() => {
            const blanket = d.keys.filter((k) => k.pct_of_spend >= 0.5 && !isExcluded(k.key));
            if (!blanket.length) return null;
            return (
              <div className="card border-l-4 border-l-warning flex flex-col gap-2">
                <h3 className="text-sm font-semibold">Coverage looks inflated by blanket tags</h3>
                <p className="text-xs text-neutral">
                  {blanket.map((k) => `${k.key} (on ${fmtPct(k.pct_of_spend)} of spend)`).join(", ")}{" "}
                  cover most of the estate — keys like these are usually workspace-default tags or
                  platform-injected ones, not deliberate cost attribution. Excluding them makes the
                  coverage numbers measure the tags your teams actually apply; the excluded keys stay
                  searchable below.
                </p>
                <div className="flex items-center gap-2 flex-wrap">
                  {blanket.map((k) => (
                    <button
                      key={k.key}
                      type="button"
                      onClick={() => void toggleExcluded(k)}
                      disabled={savingKey !== null}
                      className="px-2.5 py-1 rounded-lg border border-border text-xs text-neutral hover:text-brand-dark hover:bg-surface transition disabled:opacity-50"
                    >
                      {savingKey === k.key ? "Saving…" : `Exclude ${k.key}`}
                    </button>
                  ))}
                </div>
              </div>
            );
          })()}

          {saveError && <ErrorCard message={saveError} />}

          <div className="card flex flex-col gap-2">
            <h3 className="text-sm font-semibold flex items-center gap-1.5">
              Coverage by product
              <InfoTip text="Which billing products carry tags on their usage. Untagged products are where chargeback attribution goes dark — serverless workloads take tags from budget policies; classic compute from cluster/warehouse tags." />
            </h3>
            <DataTable
              columns={covColumns}
              rows={d.by_product}
              rowKey={(r) => r.product}
              initialSort={{ key: "usd", dir: "desc" }}
              emptyMessage="No billed usage this month."
            />
          </div>

          <div className="card flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <h3 className="text-sm font-semibold flex items-center gap-1.5">
                Tag catalog — search any tag
                <InfoTip text="Every tag key found on billed usage or Unity Catalog securables. Expand a row to list everything carrying the tag and its month-to-date cost, optionally filtered to one value." />
              </h3>
              <SearchBox value={search} onChange={setSearch} placeholder="Search tag key…" />
            </div>
            <DataTable
              columns={keyColumns}
              rows={keys}
              rowKey={(r) => r.key}
              initialSort={{ key: "usd", dir: "desc" }}
              emptyMessage="No tag keys match."
              renderExpanded={(r) => <TagExplorer tagKey={r.key} cur={cur} />}
            />
            <p className="text-[11px] text-neutral">
              Spend figures are month-to-date at list price. A usage row carrying several tags counts fully
              under each of its keys — the catalog answers "how much spend carries this tag", not a
              partition of total spend.
            </p>
          </div>
        </>
      )}
    </PageShell>
  );
}
