"use client";

/** Small inline spinner. `light` for use on a filled accent button. */
export function Spinner({ light = false, className = "" }: { light?: boolean; className?: string }) {
  return (
    <span
      className={`inline-block h-4 w-4 animate-spin rounded-full border-2 ${
        light ? "border-accent-on/30 border-t-accent-on" : "border-line-strong border-t-accent"
      } ${className}`}
      aria-hidden
    />
  );
}

/** Indeterminate progress bar (unknown duration). */
export function ProgressBar({ className = "" }: { className?: string }) {
  return (
    <div className={`relative h-1 w-full overflow-hidden rounded-full bg-accent-soft ${className}`}>
      <span className="absolute top-0 h-full rounded-full bg-accent animate-indeterminate" />
    </div>
  );
}

/** Full-screen blocking overlay with spinner + progress bar + label.
 *  Use for longer waits (AI sectioning, saving, file parsing). */
export function LoadingOverlay({ label, sub }: { label: string; sub?: string }) {
  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-[var(--overlay)] p-6 backdrop-blur-sm animate-fade">
      <div className="card w-full max-w-xs animate-rise p-6 text-center shadow-2">
        <Spinner className="mx-auto mb-4 !h-8 !w-8 !border-[2.5px]" />
        <p className="font-medium text-ink">{label}</p>
        {sub && <p className="mt-1 text-[13px] text-ink-3">{sub}</p>}
        <ProgressBar className="mt-4" />
      </div>
    </div>
  );
}

/** Thin top-of-container progress bar for ambient waits. */
export function TopProgress() {
  return (
    <div className="absolute inset-x-0 top-0 z-20 h-0.5 overflow-hidden bg-accent-soft">
      <span className="absolute top-0 h-full rounded-full bg-accent animate-indeterminate" />
    </div>
  );
}

/** Three-dot "thinking" indicator. */
export function ThinkingDots({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 ${className}`} aria-label="thinking">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 rounded-full bg-ink-3 animate-dot-wave"
          style={{ animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </span>
  );
}
