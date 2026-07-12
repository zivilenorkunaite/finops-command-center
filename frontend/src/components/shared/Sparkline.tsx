interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
}

// Lightweight inline SVG sparkline — no chart lib overhead for table cells.
export function Sparkline({ data, width = 88, height = 26, color = "rgb(var(--color-accent))" }: SparklineProps) {
  if (!data || data.length < 2) return <span className="text-neutral text-xs">—</span>;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const step = width / (data.length - 1);
  const points = data
    .map((v, i) => `${(i * step).toFixed(1)},${(height - ((v - min) / range) * height).toFixed(1)}`)
    .join(" ");
  const last = data[data.length - 1];
  const first = data[0];
  const rising = last >= first;
  const strokeColor = rising ? "#C0392B" : "#1B8A4A"; // rising spend = danger, falling = good
  void color;
  return (
    <svg width={width} height={height} className="overflow-visible" aria-hidden>
      <polyline points={points} fill="none" stroke={strokeColor} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle
        cx={((data.length - 1) * step).toFixed(1)}
        cy={(height - ((last - min) / range) * height).toFixed(1)}
        r={2}
        fill={strokeColor}
      />
    </svg>
  );
}
