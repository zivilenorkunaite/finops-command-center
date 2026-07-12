// Formatting helpers shared across pages.

export interface MoneyCurrency {
  symbol: string;
  rate: number; // multiply a USD figure by this to get the display currency
}

// USD (list-price) formatter. Kept for surfaces that are intentionally USD-only.
export function fmtUsd(n: number, opts: { compact?: boolean } = {}): string {
  if (opts.compact) {
    if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
    if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
    return `$${n.toFixed(0)}`;
  }
  return `$${Math.round(n).toLocaleString("en-AU")}`;
}

// Currency-aware money formatter. Takes a USD figure and
// the active currency option; applies the FX rate + symbol. USD passes through
// identically to fmtUsd.
export function fmtMoney(
  usd: number,
  cur: MoneyCurrency,
  opts: { compact?: boolean } = {},
): string {
  const n = usd * cur.rate;
  const s = cur.symbol;
  if (opts.compact) {
    if (Math.abs(n) >= 1e6) return `${s}${(n / 1e6).toFixed(2)}M`;
    if (Math.abs(n) >= 1e3) return `${s}${(n / 1e3).toFixed(1)}K`;
    return `${s}${n.toFixed(0)}`;
  }
  return `${s}${Math.round(n).toLocaleString("en-AU")}`;
}

export function fmtNum(n: number, opts: { compact?: boolean } = {}): string {
  if (opts.compact) {
    if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
    if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
    return `${Math.round(n)}`;
  }
  return Math.round(n).toLocaleString("en-AU");
}

export function fmtPct(n: number, decimals = 0): string {
  return `${(n * 100).toFixed(decimals)}%`;
}

export function fmtBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}
