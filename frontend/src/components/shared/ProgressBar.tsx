interface ProgressBarProps {
  value: number; // 0..1
  label?: string;
  tone?: "accent" | "success" | "warning" | "danger" | "info";
  showPct?: boolean;
}

const TONE: Record<NonNullable<ProgressBarProps["tone"]>, string> = {
  accent: "bg-accent",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  info: "bg-info",
};

export function ProgressBar({ value, label, tone = "accent", showPct = true }: ProgressBarProps) {
  const pct = Math.max(0, Math.min(1, value));
  return (
    <div className="flex flex-col gap-1 min-w-[90px]">
      {label && <span className="text-[11px] text-neutral">{label}</span>}
      <div className="flex items-center gap-2">
        <div className="h-1.5 flex-1 rounded-full bg-border/60 overflow-hidden">
          <div className={`h-full rounded-full ${TONE[tone]}`} style={{ width: `${pct * 100}%` }} />
        </div>
        {showPct && <span className="text-[11px] tabular-nums text-neutral w-9 text-right">{Math.round(pct * 100)}%</span>}
      </div>
    </div>
  );
}

// Compact 0-100 impact score bar used in the Query Advisor table.
export function ScoreBar({ score }: { score: number }) {
  const pct = Math.max(0, Math.min(100, score));
  const tone = pct >= 70 ? "danger" : pct >= 40 ? "warning" : "success";
  const color = tone === "danger" ? "bg-danger" : tone === "warning" ? "bg-warning" : "bg-success";
  return (
    <div className="flex items-center gap-2 min-w-[70px]">
      <div className="h-1.5 flex-1 rounded-full bg-border/60 overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[11px] tabular-nums text-neutral w-6 text-right">{pct}</span>
    </div>
  );
}
