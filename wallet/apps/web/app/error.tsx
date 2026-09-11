'use client';

/**
 * The App Router's error boundary — a rendering crash, not an API failure.
 * API failures are handled where they happen and carry a correlation id
 * (rule 167); this is the last resort when a component throws.
 */
export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="mx-auto max-w-md py-24 text-center">
      <p className="font-mono text-2xs uppercase tracking-[0.2em] text-danger">Error</p>
      <h1 className="mt-4 text-xl font-semibold tracking-[-0.01em] text-ink">
        Something went wrong
      </h1>
      {/*
        "Nothing was submitted" is the sentence that matters. A render failure
        in a wallet makes a user wonder whether their money moved; saying so
        plainly is worth more than any styling on this page.
      */}
      <p className="mx-auto mt-2.5 max-w-sm text-sm leading-relaxed text-ink-muted">
        The page failed to render. Nothing was submitted.
      </p>
      <button
        onClick={reset}
        className="mt-7 text-sm text-accent transition-colors duration-micro ease-atlas hover:text-accent-strong"
      >
        Try again
      </button>
    </div>
  );
}
