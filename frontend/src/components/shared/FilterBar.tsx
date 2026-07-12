import type { ReactNode } from "react";

export function FilterBar({ children }: { children: ReactNode }) {
  return (
    <div className="card flex flex-wrap items-center gap-3 py-3">
      {children}
    </div>
  );
}

export function TimeRangeChips({
  value,
  onChange,
  options = ["24h", "7d"],
}: {
  value: string;
  onChange: (v: string) => void;
  options?: string[];
}) {
  return (
    <div className="inline-flex rounded-lg border border-border overflow-hidden">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => onChange(opt)}
          className={`px-2.5 py-1 text-xs font-medium transition ${
            value === opt ? "bg-accent text-white" : "text-neutral hover:text-brand-dark hover:bg-surface"
          }`}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}

export function Dropdown({
  label,
  value,
  onChange,
  options,
}: {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  const fieldName = `filter-${(label ?? "dropdown").toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <label className="inline-flex items-center gap-1.5 text-xs text-neutral">
      {label && <span className="whitespace-nowrap">{label}</span>}
      <select
        id={fieldName}
        name={fieldName}
        aria-label={label ?? "filter"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-lg border border-border bg-card px-2.5 py-1 text-xs text-brand-dark focus:outline-none focus:ring-1 focus:ring-accent"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function SearchBox({
  value,
  onChange,
  placeholder = "Search…",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="relative flex-1 min-w-[160px]">
      <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral text-xs">⌕</span>
      <input
        type="text"
        name="search"
        aria-label={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-border bg-card pl-7 pr-3 py-1 text-xs text-brand-dark placeholder:text-neutral focus:outline-none focus:ring-1 focus:ring-accent"
      />
    </div>
  );
}

export function ThresholdSlider({
  label,
  value,
  min,
  max,
  step = 1,
  unit = "",
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="inline-flex items-center gap-2 text-xs text-neutral">
      <span className="whitespace-nowrap">{label}</span>
      <input
        type="range"
        name="threshold"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-28 accent-[color:rgb(var(--color-accent))]"
      />
      <span className="tabular-nums text-brand-dark w-12">
        {value}
        {unit}
      </span>
    </label>
  );
}
