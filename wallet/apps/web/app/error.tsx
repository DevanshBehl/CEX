'use client';

/**
 * The App Router's error boundary — a rendering crash, not an API failure.
 * API failures are handled where they happen and carry a correlation id
 * (rule 167); this is the last resort when a component throws.
 */
export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="text-lg font-semibold">Something went wrong</h1>
      <p className="mt-2 text-sm text-muted">The page failed to render. Nothing was submitted.</p>
      <button onClick={reset} className="mt-6 text-sm text-accent underline">
        Try again
      </button>
    </div>
  );
}
