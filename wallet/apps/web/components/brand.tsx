/**
 * The Atlas mark (design.md §46).
 *
 * An A inside a bounding frame: two legs rising to an apex, crossed by a
 * horizontal axis. The frame is drawn in the text colour and the A in the
 * accent, so the mark reads as one glyph on either theme and the accent marks
 * the letter rather than the box.
 *
 * Stroke geometry only, so it stays legible at 16px.
 */
export function Mark({ className = 'h-[22px] w-[22px]' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="2.5" y="2.5" width="19" height="19" rx="4" className="stroke-ink" />
      <path d="M7.5 15.5 12 7l4.5 8.5M9.3 12.6h5.4" className="stroke-accent-strong" />
    </svg>
  );
}

/**
 * The wordmark: `Atlas` beside the product it is, set as a small tag.
 *
 * The product tag is what lets a future Atlas surface (the exchange) swap one
 * word and inherit everything else.
 */
export function Wordmark({ product = 'Wallet' }: { product?: string }) {
  return (
    <span className="inline-flex items-center gap-[9px]">
      <Mark />
      <span className="text-[15px] font-bold tracking-[-0.01em] text-ink">Atlas</span>
      <span className="rounded-sm bg-surface-active px-1.5 py-0.5 text-[10.5px] font-semibold leading-none text-ink-muted">
        {product}
      </span>
    </span>
  );
}
