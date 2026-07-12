import { useCallback, useEffect, useId, useRef, useState } from "react";

interface InfoTipProps {
  /** Plain-language explanation of the metric / term. */
  text: string;
  /** Optional accessible label for the trigger. Defaults to "What is this?". */
  label?: string;
  /** Visual size of the trigger glyph. */
  size?: "sm" | "md";
}

// Bubble geometry: wide enough to read, never wider than the viewport.
const BUBBLE_MAX_W = 320;
const EDGE = 8;

interface BubbleStyle {
  top?: number;
  bottom?: number;
  left: number;
  width: number;
}

/**
 * A small "?" affordance that reveals a plain-language definition of a metric.
 * Opens on hover, keyboard focus, or tap; closes on blur, mouse-leave, scroll,
 * or Escape.
 *
 * The bubble renders with `position: fixed` and is CLAMPED to the viewport:
 * fixed positioning escapes `overflow` ancestors (table scroll wrappers used
 * to clip it), and an explicit width + `whitespace-normal` beats any
 * `whitespace-nowrap` inherited from table headers. Safe to drop next to KPI
 * labels, table headers, and section titles anywhere.
 */
export function InfoTip({ text, label = "What is this?", size = "sm" }: InfoTipProps) {
  const [style, setStyle] = useState<BubbleStyle | null>(null);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const tipId = useId();

  const show = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(BUBBLE_MAX_W, vw - EDGE * 2);
    const left = Math.min(Math.max(r.left + r.width / 2 - width / 2, EDGE), vw - width - EDGE);
    // Below the trigger by default; above when the trigger sits near the
    // bottom of the viewport (anchor via `bottom` so height never matters).
    if (vh - r.bottom < 160) {
      setStyle({ bottom: vh - r.top + 6, left, width });
    } else {
      setStyle({ top: r.bottom + 6, left, width });
    }
  }, []);
  const hide = useCallback(() => setStyle(null), []);

  useEffect(() => {
    if (!style) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };
    // A fixed bubble would drift away from its trigger on any scroll —
    // capture-phase listener also catches scrolls inside table wrappers.
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [style, hide]);

  const glyph = size === "md" ? "h-4 w-4 text-[11px]" : "h-3.5 w-3.5 text-[10px]";

  return (
    <span ref={wrapRef} className="relative inline-flex align-middle">
      <button
        type="button"
        aria-label={label}
        aria-describedby={style ? tipId : undefined}
        className={`${glyph} inline-flex items-center justify-center rounded-full border border-border bg-transparent font-semibold leading-none text-neutral transition-colors hover:border-accent hover:text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60`}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={(e) => {
          e.stopPropagation();
          style ? hide() : show();
        }}
      >
        ?
      </button>
      {style && (
        <span
          id={tipId}
          role="tooltip"
          style={{
            top: style.top,
            bottom: style.bottom,
            left: style.left,
            width: style.width,
          }}
          className="fixed z-50 rounded-lg border border-border bg-card px-3 py-2 text-left text-xs font-normal normal-case leading-snug tracking-normal whitespace-normal break-words text-brand-dark shadow-card"
        >
          {text}
        </span>
      )}
    </span>
  );
}
