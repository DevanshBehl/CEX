/**
 * The Atlas mark (design.md §46).
 *
 * A coordinate intersection built from an abstract A: two ascending strokes
 * meeting at a node, crossed by a horizontal axis, inside a bounding frame.
 * It reads as a structural glyph rather than an icon — the "axis / connected
 * nodes / geometric structure" direction the brief asks for, and deliberately
 * not a globe.
 *
 * Stroke geometry on `currentColor` so it inherits wherever it sits: sidebar,
 * auth view, loading state, favicon. No fills except the nodes, so it stays
 * legible at 16px.
 */
export function Mark({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {/* The frame — the coordinate space the mark sits in. */}
      <rect x="2.5" y="2.5" width="19" height="19" rx="5" opacity="0.22" />
      {/* The A: two legs rising to an apex. */}
      <path d="M7 17.5 12 6.5l5 11" />
      {/* The crossbar, which is also the axis. */}
      <path d="M9.2 13.4h5.6" opacity="0.75" />
      {/* The apex node. */}
      <circle cx="12" cy="6.5" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

/**
 * The wordmark. `ATLAS` set in caps with wide tracking — the register the brief
 * asks for, and the thing that makes the product read as infrastructure rather
 * than an app. `WALLET` sits beside it as the product within the ecosystem, so
 * a future Atlas surface can swap that word and inherit everything else.
 */
export function Wordmark({ product = 'Wallet' }: { product?: string }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <Mark className="h-[22px] w-[22px] text-accent-strong" />
      <span className="flex items-baseline gap-1.5">
        <span className="text-[13px] font-semibold uppercase tracking-[0.16em] text-ink">
          Atlas
        </span>
        <span className="text-[11px] font-medium tracking-[0.02em] text-ink-muted">{product}</span>
      </span>
    </span>
  );
}
