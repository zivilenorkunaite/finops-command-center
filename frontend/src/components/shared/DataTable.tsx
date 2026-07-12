import { Fragment, useMemo, useState } from "react";
import type { ReactNode } from "react";

export interface Column<T> {
  key: string;
  header: ReactNode;
  // value used for sorting; if omitted the column is not sortable
  sortValue?: (row: T) => number | string;
  // custom cell renderer
  render?: (row: T) => ReactNode;
  // simple accessor when no render is provided
  accessor?: (row: T) => ReactNode;
  align?: "left" | "right" | "center";
  className?: string;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string | number;
  initialSort?: { key: string; dir: "asc" | "desc" };
  // expandable row detail
  renderExpanded?: (row: T) => ReactNode;
  emptyMessage?: string;
  dense?: boolean;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  initialSort,
  renderExpanded,
  emptyMessage = "No rows match the current filters.",
  dense = true,
}: DataTableProps<T>) {
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(initialSort ?? null);
  const [expanded, setExpanded] = useState<Set<string | number>>(new Set());

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return rows;
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = col.sortValue!(a);
      const vb = col.sortValue!(b);
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });
  }, [rows, sort, columns]);

  function toggleSort(key: string) {
    const col = columns.find((c) => c.key === key);
    if (!col?.sortValue) return;
    setSort((prev) => {
      if (prev?.key !== key) return { key, dir: "desc" };
      if (prev.dir === "desc") return { key, dir: "asc" };
      return null;
    });
  }

  function toggleExpand(k: string | number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  const pad = dense ? "px-3 py-2" : "px-4 py-3";

  return (
    <div className="card p-0 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b border-border bg-surface/60">
              {renderExpanded && <th className="w-8" />}
              {columns.map((col) => {
                const active = sort?.key === col.key;
                const alignCls = col.align === "right" ? "text-right" : col.align === "center" ? "text-center" : "text-left";
                return (
                  <th
                    key={col.key}
                    onClick={() => toggleSort(col.key)}
                    className={`${pad} ${alignCls} text-[11px] font-semibold uppercase tracking-wide text-neutral whitespace-nowrap ${
                      col.sortValue ? "cursor-pointer select-none hover:text-brand-dark" : ""
                    } ${col.className ?? ""}`}
                  >
                    <span className="inline-flex items-center gap-1">
                      {col.header}
                      {col.sortValue && (
                        <span className="text-[9px] leading-none text-neutral/70">
                          {active ? (sort!.dir === "desc" ? "▼" : "▲") : "↕"}
                        </span>
                      )}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 && (
              <tr>
                <td colSpan={columns.length + (renderExpanded ? 1 : 0)} className="px-4 py-10 text-center text-neutral">
                  {emptyMessage}
                </td>
              </tr>
            )}
            {sorted.map((row) => {
              const k = rowKey(row);
              const isExpanded = expanded.has(k);
              return (
                <Fragment key={k}>
                  <tr
                    className={`border-b border-border/60 hover:bg-surface/50 transition ${renderExpanded ? "cursor-pointer" : ""}`}
                    onClick={renderExpanded ? () => toggleExpand(k) : undefined}
                  >
                    {renderExpanded && (
                      <td className={`${pad} text-neutral text-xs`}>{isExpanded ? "▾" : "▸"}</td>
                    )}
                    {columns.map((col) => {
                      const alignCls = col.align === "right" ? "text-right" : col.align === "center" ? "text-center" : "text-left";
                      return (
                        <td key={col.key} className={`${pad} ${alignCls} ${col.className ?? ""}`}>
                          {col.render ? col.render(row) : col.accessor ? col.accessor(row) : null}
                        </td>
                      );
                    })}
                  </tr>
                  {renderExpanded && isExpanded && (
                    <tr className="bg-surface/40">
                      <td colSpan={columns.length + 1} className="px-4 py-4">
                        {renderExpanded(row)}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
