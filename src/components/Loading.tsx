"use client";

/** Small inline spinner. `light` for use on a colored button. */
export function Spinner({ light = false, className = "" }: { light?: boolean; className?: string }) {
  return (
    <span
      className={`inline-block h-4 w-4 animate-spin rounded-full border-2 ${
        light ? "border-white/40 border-t-white" : "border-brand-200 border-t-brand-500"
      } ${className}`}
      aria-hidden
    />
  );
}

/** Indeterminate progress bar (unknown duration). */
export function ProgressBar({ className = "" }: { className?: string }) {
  return (
    <div className={`relative h-1.5 w-full overflow-hidden rounded-full bg-brand-50 ${className}`}>
      <span className="absolute top-0 h-full rounded-full bg-brand-500 animate-indeterminate" />
    </div>
  );
}

/** Full-screen blocking overlay with spinner + progress bar + label.
 *  Use for longer waits (AI sectioning, saving, file parsing). */
export function LoadingOverlay({ label, sub }: { label: string; sub?: string }) {
  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/30 p-6 backdrop-blur-sm">
      <div className="w-full max-w-xs animate-fade-up rounded-3xl bg-white p-6 text-center shadow-lift">
        <Spinner className="mx-auto mb-4 !h-9 !w-9 !border-[3px]" />
        <p className="font-medium">{label}</p>
        {sub && <p className="mt-1 text-xs text-ink-mute">{sub}</p>}
        <ProgressBar className="mt-4" />
      </div>
    </div>
  );
}

/** Thin top-of-viewport progress bar for ambient waits. */
export function TopProgress() {
  return (
    <div className="absolute inset-x-0 top-0 z-50 h-0.5 overflow-hidden bg-brand-100">
      <span className="absolute top-0 h-full rounded-full bg-brand-500 animate-indeterminate" />
    </div>
  );
}
