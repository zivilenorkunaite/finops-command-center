import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useGenieStream } from "../../hooks/useGenieStream";

// Persistent "Ask Genie about your costs & usage" banner. Rendered
// beneath the nav ONLY when features.genie is on (App.tsx gates it). Streams
// answers via /api/genie/ask (SSE) — live: Genie Conversation API against the
// configured Genie Space.
// source of truth" caveat.

// Suggested prompts — one per space capability (cost, usage of data assets,
// access, tagging), each backed by a curated example in
// resources/finops.geniespace.json.
const SUGGESTED = [
  "What are our top 3 cost drivers this month?",
  "What are the 10 most-read tables in the last 30 days?",
  "Who has access to which catalogs?",
  "How much of our spend is untagged?",
];

const THINKING_DELAY_MS = 350;

function SparkIcon() {
  return (
    <svg viewBox="0 0 24 24" width={22} height={22} fill="rgb(var(--color-accent))" aria-hidden>
      <path d="M12 2 14 9 21 12 14 15 12 22 10 15 3 12 10 9z" />
    </svg>
  );
}

function AnswerChart({ chart }: { chart: { labels: string[]; values: number[]; unit: string } }) {
  const max = Math.max(1, ...chart.values);
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      {chart.labels.map((label, i) => (
        <div key={label + i} className="flex items-center gap-2 text-xs">
          <span className="w-40 shrink-0 truncate text-neutral" title={label}>
            {label}
          </span>
          <div className="h-2 flex-1 rounded-full bg-border/60 overflow-hidden">
            <div className="h-full rounded-full bg-accent" style={{ width: `${(chart.values[i] / max) * 100}%` }} />
          </div>
          <span className="w-24 shrink-0 text-right tabular-nums text-neutral">
            {chart.values[i].toLocaleString("en-AU")}
            {chart.unit === "USD" || chart.unit === "USD/mo" ? "" : ""}
          </span>
        </div>
      ))}
      <span className="text-[10px] uppercase tracking-wide text-neutral">{chart.unit}</span>
    </div>
  );
}

export function AskGenieBanner() {
  const [draft, setDraft] = useState("");
  const [activeQuestion, setActiveQuestion] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [thinking, setThinking] = useState(false);
  const [open, setOpen] = useState(false);

  const request = useMemo(() => {
    if (!activeQuestion || thinking) return null;
    return { question: activeQuestion, nonce };
  }, [activeQuestion, thinking, nonce]);

  const stream = useGenieStream(request);

  const submit = (raw: string) => {
    const question = raw.trim();
    if (!question) return;
    setDraft(question);
    setOpen(true);
    setActiveQuestion(null);
    setThinking(true);
    window.setTimeout(() => {
      setActiveQuestion(question);
      setNonce((n) => n + 1);
      setThinking(false);
    }, THINKING_DELAY_MS);
  };

  const showResponse = open && (thinking || stream.streaming || stream.done || stream.error);

  return (
    <div className="bg-surface/60 border-b border-border">
      <div className="max-w-[1500px] mx-auto px-6 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 shrink-0">
            <SparkIcon />
            <div className="leading-tight">
              <div className="text-sm font-semibold">Ask Genie about your costs &amp; usage</div>
              <div className="text-[11px] text-neutral">Natural-language questions over your cost, usage &amp; access data</div>
            </div>
          </div>

          <form
            className="flex flex-1 min-w-[260px] gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              submit(draft);
            }}
          >
            <input
              type="text"
              id="ask-genie-input"
              name="ask-genie"
              aria-label="Ask Genie about your costs and usage"
              value={draft}
              onChange={(e) => setDraft(e.currentTarget.value)}
              placeholder="e.g. What are our top cost drivers this month?"
              className="flex-1 rounded-lg border border-border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
            />
            <button
              type="submit"
              disabled={!draft.trim() || thinking || stream.streaming}
              className="rounded-lg bg-accent text-white px-4 py-2 text-sm font-semibold hover:bg-accent/90 transition flex items-center gap-1 disabled:opacity-50"
            >
              Ask <span aria-hidden>→</span>
            </button>
          </form>
        </div>

        {/* Suggested-prompt chips */}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {SUGGESTED.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => submit(q)}
              className="pill bg-card border border-border text-neutral hover:text-brand-dark hover:border-accent transition"
            >
              {q}
            </button>
          ))}
        </div>

        {/* Streamed answer */}
        {showResponse && (
          <div className="mt-3 card flex flex-col gap-2 py-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs italic text-neutral line-clamp-1">
                {stream.meta?.asked_question ?? activeQuestion ?? draft}
              </span>
              <div className="flex items-center gap-2 shrink-0">
                {stream.meta?.source && (
                  <span className={`pill ${stream.meta.source === "genie" ? "bg-success/15 text-success" : "bg-info/15 text-info"}`}>
                    {stream.meta.source === "genie" ? "Genie Space" : "no live answer"}
                  </span>
                )}
                <button type="button" onClick={() => setOpen(false)} className="text-[11px] text-neutral hover:text-brand-dark" aria-label="Dismiss answer">
                  ✕
                </button>
              </div>
            </div>

            {thinking || (stream.streaming && !stream.text) ? (
              <div className="flex items-center gap-2 text-sm text-neutral">
                <span className="inline-block h-2 w-2 rounded-full bg-accent animate-pulse" />
                Genie is thinking…
              </div>
            ) : stream.error ? (
              <div className="text-sm text-danger">Could not reach Genie: {stream.error}</div>
            ) : (
              <>
                <div className="prose-genie text-sm leading-relaxed text-brand-dark [&_strong]:text-brand-dark [&_strong]:font-semibold [&_p]:my-1.5 [&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5 [&_table]:my-2 [&_table]:text-xs [&_table]:border-collapse [&_th]:text-left [&_th]:font-medium [&_th]:text-neutral [&_th]:border-b [&_th]:border-border [&_th]:px-2.5 [&_th]:py-1 [&_td]:px-2.5 [&_td]:py-1 [&_td]:border-b [&_td]:border-border/50 [&_td]:tabular-nums">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{stream.text}</ReactMarkdown>
                </div>
                {stream.meta?.chart && stream.meta.chart.values.length > 0 && (
                  <AnswerChart chart={stream.meta.chart} />
                )}
                {stream.done && stream.meta?.follow_ups && stream.meta.follow_ups.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 pt-1">
                    <span className="text-[10px] uppercase tracking-wide text-neutral">Follow up</span>
                    {stream.meta.follow_ups.map((f) => (
                      <button
                        key={f}
                        type="button"
                        onClick={() => submit(f)}
                        className="pill bg-surface border border-border text-neutral hover:text-brand-dark hover:border-accent transition"
                      >
                        {f}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
