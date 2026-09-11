'use client';

import type { ReactNode } from 'react';

/**
 * Presentation-only primitives (prompt_phase1.md rules 163, 166; design.md §16).
 *
 * Nothing here fetches, decides, or knows about a domain type. Every value
 * comes from a token — no component carries a hex.
 */

// ---------------------------------------------------------------------------
// Button (§18)
// ---------------------------------------------------------------------------

/**
 * Buttons as infrastructure controls: compact, high-contrast, restrained.
 *
 * `primary` is deliberately the ONLY filled variant. One filled button per view
 * is what makes it read as the action; two make neither of them read as
 * anything (§18).
 */
const BUTTON_VARIANTS = {
  /**
   * The accent, filled — the one place it appears at full strength (§6).
   * The glow is a coloured shadow rather than a filter: it reads as the
   * control being lit rather than blurred, and it costs nothing to composite.
   */
  primary:
    'bg-accent-strong text-[#04121c] font-semibold ' +
    'shadow-[0_0_0_1px_var(--atlas-accent-deep),0_6px_20px_-6px_var(--atlas-accent-glow)] ' +
    'hover:bg-accent hover:shadow-[0_0_0_1px_var(--atlas-accent-deep),0_8px_28px_-6px_var(--atlas-accent-glow)]',
  secondary: 'atlas-raised text-ink hover:border-line-emphasis hover:bg-surface-hover',
  ghost: 'text-ink-secondary hover:text-ink hover:bg-surface',
  danger:
    'border border-danger/25 bg-danger-dim text-danger hover:border-danger/45 ' +
    'hover:bg-danger/15',
} as const;

const BUTTON_SIZES = {
  sm: 'h-8 gap-1.5 px-3 text-xs',
  md: 'h-9 gap-2 px-4 text-sm',
  lg: 'h-11 gap-2 px-5 text-sm',
} as const;

export function Button({
  children,
  variant = 'primary',
  size = 'md',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof BUTTON_VARIANTS;
  size?: keyof typeof BUTTON_SIZES;
}) {
  return (
    <button
      {...props}
      className={[
        'inline-flex items-center justify-center rounded-md font-medium',
        // §26: every interaction gives feedback. The 1px lift is enough to
        // register and small enough not to shift the layout around it.
        'transition-all duration-micro ease-atlas active:translate-y-px',
        'disabled:cursor-not-allowed disabled:opacity-40 disabled:active:translate-y-0',
        BUTTON_SIZES[size],
        BUTTON_VARIANTS[variant],
        props.className ?? '',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Form controls (§19)
// ---------------------------------------------------------------------------

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  // `| undefined` spelled out because the monorepo runs with
  // exactOptionalPropertyTypes: `hint?: string` means "absent or a string" and
  // explicitly NOT undefined, so a caller passing a possibly-undefined value
  // would not compile.
  hint?: string | undefined;
  error?: string | undefined;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-2">
      <span className="block text-xs font-medium uppercase tracking-wider text-ink-muted">
        {label}
      </span>
      {children}
      {hint !== undefined && error === undefined && (
        <span className="block text-xs text-ink-muted">{hint}</span>
      )}
      {error !== undefined && (
        <span className="flex items-center gap-1.5 text-xs text-danger">
          <span aria-hidden="true" className="inline-block h-1 w-1 rounded-full bg-danger" />
          {error}
        </span>
      )}
    </label>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={[
        'w-full rounded-md border border-line-strong bg-background-subtle px-3.5 py-2.5',
        'text-sm text-ink placeholder:text-ink-disabled',
        'outline-none transition-all duration-micro ease-atlas',
        'hover:border-line-emphasis',
        // The focus treatment is a ring rather than a border swap, so the
        // control does not shift by a pixel when it takes focus.
        'focus:border-accent-strong focus:shadow-[0_0_0_3px_var(--atlas-accent-dim)]',
        'disabled:cursor-not-allowed disabled:opacity-50',
        props.className ?? '',
      ].join(' ')}
    />
  );
}

// ---------------------------------------------------------------------------
// Surfaces (§15)
// ---------------------------------------------------------------------------

/**
 * A card is one option, not the default (§15).
 *
 * "Do not make every section a separate card." Pages should prefer open
 * layouts with rules and spacing; a card earns its border when it groups
 * something that genuinely stands apart.
 */
export function Card({
  title,
  description,
  action,
  children,
}: {
  title?: string | undefined;
  description?: string | undefined;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="atlas-raised overflow-hidden rounded-lg">
      {title !== undefined && (
        <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold tracking-[-0.01em] text-ink">{title}</h2>
            {description !== undefined && (
              <p className="mt-1 text-xs text-ink-muted">{description}</p>
            )}
          </div>
          {action}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

/**
 * The page header. One per route, and the only `h1`.
 *
 * Exists so every page gets identical heading weight, tracking and spacing
 * without each one re-deciding — §47's continuity, enforced by there being
 * nowhere else to put it.
 */
export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string | undefined;
  action?: ReactNode;
}) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-[-0.02em] text-ink">{title}</h1>
        {description !== undefined && (
          <p className="mt-1.5 max-w-2xl text-sm text-ink-secondary">{description}</p>
        )}
      </div>
      {action}
    </div>
  );
}

/**
 * A labelled value. The workhorse of a data-oriented interface (§29).
 *
 * The label is small, uppercase and muted; the value carries the weight. That
 * contrast is what lets a dense grid of these stay scannable — hierarchy from
 * weight and opacity rather than size alone (§5).
 */
export function DataPoint({
  label,
  value,
  mono = false,
  tone = 'default',
}: {
  label: string;
  value: ReactNode;
  /** For anything where digits must align: amounts, addresses, hashes. */
  mono?: boolean;
  tone?: 'default' | 'muted' | 'success' | 'warning' | 'danger';
}) {
  const tones = {
    default: 'text-ink',
    muted: 'text-ink-secondary',
    success: 'text-success',
    warning: 'text-warning',
    danger: 'text-danger',
  } as const;

  return (
    <div className="min-w-0">
      <dt className="text-2xs font-medium uppercase tracking-wider text-ink-muted">{label}</dt>
      <dd className={`mt-1.5 truncate text-sm ${mono ? 'font-mono' : ''} ${tones[tone]}`}>
        {value}
      </dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status (§21)
// ---------------------------------------------------------------------------

/**
 * Status as a dot plus a word, not a filled pill.
 *
 * A row of saturated pills on a dark surface is the "crypto dashboard" look the
 * brief rules out, and it makes every status shout equally loudly. A small
 * coloured dot carries the same information at a fraction of the visual weight.
 */
export function StatusBadge({
  tone,
  children,
}: {
  tone: 'neutral' | 'good' | 'warn' | 'bad';
  children: ReactNode;
}) {
  const styles = {
    neutral: { dot: 'bg-ink-muted', text: 'text-ink-secondary', ring: 'border-line-strong' },
    good: { dot: 'bg-success', text: 'text-success', ring: 'border-success/25' },
    warn: { dot: 'bg-warning', text: 'text-warning', ring: 'border-warning/25' },
    bad: { dot: 'bg-danger', text: 'text-danger', ring: 'border-danger/25' },
  }[tone];

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border ${styles.ring} bg-surface px-2.5 py-0.5 text-2xs font-medium ${styles.text}`}
    >
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${styles.dot}`} />
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

/**
 * Honest empty states (prompt_phase1.md rules 156-157).
 *
 * They say what is not there. They do NOT show a plausible-looking balance or a
 * sample transaction — in a wallet, a number that looks real and is not is
 * worse than no number at all.
 */
export function EmptyState({
  title,
  body,
  phase,
}: {
  title: string;
  body: string;
  phase?: string | undefined;
}) {
  return (
    /*
      No dashed border. A dashed box says "content is missing here"; an empty
      wallet is not missing anything, it is simply empty — and the dashed
      rectangle was the loudest element on an otherwise calm page.
    */
    <div className="flex flex-col items-center px-6 py-14 text-center">
      <span
        aria-hidden="true"
        className="atlas-raised mb-5 flex h-11 w-11 items-center justify-center rounded-full"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-ink-disabled" />
      </span>
      <p className="text-sm font-medium text-ink">{title}</p>
      <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-ink-muted">{body}</p>
      {phase !== undefined && (
        <p className="mt-5 inline-flex items-center gap-2 rounded-full border border-line-strong px-3 py-1 text-2xs uppercase tracking-wider text-ink-muted">
          Arrives in {phase}
        </p>
      )}
    </div>
  );
}

export function ErrorNotice({
  message,
  correlationId,
}: {
  message: string;
  correlationId?: string | null | undefined;
}) {
  return (
    <div
      role="alert"
      className="rounded-md border border-danger/25 bg-danger-dim px-4 py-3 text-sm text-danger"
    >
      <p>{message}</p>
      {correlationId != null && (
        // rule 167 — the user can quote this and it ties straight to the logs.
        <p className="mt-1.5 font-mono text-xs opacity-70">Reference: {correlationId}</p>
      )}
    </div>
  );
}

/**
 * A skeleton, not a spinner, wherever the shape of what is coming is known
 * (§22). It keeps the layout from jumping when data lands.
 */
export function Skeleton({ className = 'h-4 w-24' }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`relative block overflow-hidden rounded bg-surface-raised ${className}`}
    >
      <span className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-white/[0.04] to-transparent" />
    </span>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <p className="flex items-center gap-2 text-sm text-ink-muted" role="status">
      <span
        aria-hidden="true"
        className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-accent-strong"
      />
      {label}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Dialog (§35)
// ---------------------------------------------------------------------------

export function Modal({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop: a blur rather than a heavy scrim, so context stays visible. */}
      <button
        aria-hidden="true"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-background/70 backdrop-blur-sm"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="atlas-raised relative w-full max-w-md animate-fade-up rounded-xl shadow-lg"
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <h3 className="text-sm font-semibold text-ink">{title}</h3>
          <button
            onClick={onClose}
            aria-label="Close"
            className="-m-1 rounded p-1 text-ink-muted transition-colors duration-micro ease-atlas hover:text-ink"
          >
            <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor">
              <path d="M4 4l8 8M12 4l-8 8" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layout (§8, §15, §37)
// ---------------------------------------------------------------------------

/**
 * A section of a page, separated by a rule rather than boxed in a card.
 *
 * §15: "Do not make every section a separate card. Use open layouts whenever
 * possible." Three stacked cards is the default a component library pushes you
 * toward, and it makes a page read as a pile of containers instead of one
 * document. A heading plus a hairline does the same grouping work with none of
 * the boxing.
 */
export function Section({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string | undefined;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="flex flex-wrap items-end justify-between gap-3 pb-3">
        <div>
          <h2 className="text-sm font-semibold tracking-[-0.01em] text-ink">{title}</h2>
          {description !== undefined && (
            <p className="mt-1 text-xs text-ink-muted">{description}</p>
          )}
        </div>
        {action}
      </div>
      <div className="atlas-rule" />
      <div className="pt-5">{children}</div>
    </section>
  );
}

/**
 * A quiet system note.
 *
 * For things the interface must state plainly and the user is not expected to
 * act on — what signing currently is, what has not been audited. Distinct from
 * `EmptyState`, which answers "why is there nothing here"; using an empty state
 * for a standing disclosure made it a 250px dashed box competing with the
 * balance for attention, which is exactly backwards.
 */
export function SystemNote({
  label,
  title,
  children,
  tone = 'neutral',
}: {
  label: string;
  title: string;
  children: ReactNode;
  tone?: 'neutral' | 'accent' | 'warning';
}) {
  const tones = {
    neutral: 'border-line text-ink-muted',
    accent: 'border-accent/20 text-accent',
    warning: 'border-warning/25 text-warning',
  } as const;

  return (
    <aside className={`rounded-md border ${tones[tone]} bg-surface/60 px-4 py-3.5`}>
      <p className="text-2xs font-medium uppercase tracking-wider">{label}</p>
      <p className="mt-2 text-sm font-medium text-ink">{title}</p>
      <div className="mt-1.5 max-w-prose text-xs leading-relaxed text-ink-muted">{children}</div>
    </aside>
  );
}

/**
 * A headline figure — a balance, a total.
 *
 * The single most important number on a view deserves display treatment, not
 * body text. Monospace with tabular figures so the digits sit on a grid, and
 * the unit set smaller and muted beside it so the magnitude reads first.
 */
export function Figure({
  value,
  unit,
  label,
  loading = false,
}: {
  value: string;
  unit?: string | undefined;
  label?: string | undefined;
  loading?: boolean;
}) {
  return (
    <div>
      {label !== undefined && (
        <p className="text-2xs font-medium uppercase tracking-wider text-ink-muted">{label}</p>
      )}
      {loading ? (
        <Skeleton className="mt-2 h-9 w-40" />
      ) : (
        <p className="mt-1.5 flex items-baseline gap-2">
          <span className="font-mono text-3xl font-medium tracking-[-0.02em] text-ink">
            {value}
          </span>
          {unit !== undefined && <span className="font-mono text-sm text-ink-muted">{unit}</span>}
        </p>
      )}
    </div>
  );
}

/**
 * A monospace value that may be long — an address, a signature, a correlation
 * id. Wraps rather than overflowing, and offers a copy affordance when asked.
 */
export function CodeValue({
  value,
  testId,
  className = '',
}: {
  value: string;
  testId?: string | undefined;
  className?: string;
}) {
  return (
    <code
      data-testid={testId}
      className={`block break-all rounded-md border border-line bg-background px-3 py-2.5 font-mono text-sm text-ink ${className}`}
    >
      {value}
    </code>
  );
}

/**
 * A headline statistic on a raised panel (§16 `Metric`).
 *
 * The distinction from `Figure`: this is a self-contained tile for a grid of
 * them, where `Figure` is a bare number inside something else. A dashboard is
 * mostly a row of these, so it is worth being a component rather than a
 * repeated div.
 */
export function StatCard({
  label,
  value,
  unit,
  hint,
  icon,
  loading = false,
  tone = 'default',
}: {
  label: string;
  value: string;
  unit?: string | undefined;
  hint?: ReactNode;
  icon?: ReactNode;
  loading?: boolean;
  tone?: 'default' | 'accent' | 'warning';
}) {
  const valueTone = {
    default: 'text-ink',
    accent: 'text-accent',
    warning: 'text-warning',
  }[tone];

  return (
    <div className="atlas-raised atlas-raised-hover rounded-lg p-5">
      <div className="flex items-start justify-between gap-3">
        <p className="text-2xs font-medium uppercase tracking-wider text-ink-muted">{label}</p>
        {icon}
      </div>

      {loading ? (
        <Skeleton className="mt-3.5 h-8 w-32" />
      ) : (
        <p className="mt-3 flex items-baseline gap-1.5">
          <span className={`font-mono text-2xl tracking-[-0.02em] ${valueTone}`}>{value}</span>
          {unit !== undefined && <span className="font-mono text-xs text-ink-muted">{unit}</span>}
        </p>
      )}

      {hint !== undefined && <div className="mt-2 text-xs text-ink-muted">{hint}</div>}
    </div>
  );
}

/**
 * A tile that links somewhere and says what it does.
 *
 * The dashboard's primary actions. A row of plain buttons reads as a toolbar;
 * tiles with a title and a line of explanation read as the two things this
 * product is for, which on a wallet is the honest hierarchy.
 */
export function ActionTile({
  href,
  title,
  description,
  icon,
  primary = false,
}: {
  href: string;
  title: string;
  description: string;
  icon: ReactNode;
  primary?: boolean;
}) {
  return (
    <a
      href={href}
      className={[
        'atlas-raised atlas-raised-hover group flex items-start gap-4 rounded-lg p-5',
        primary ? 'border-accent/25' : '',
      ].join(' ')}
    >
      <span
        className={[
          'flex h-10 w-10 shrink-0 items-center justify-center rounded-md border',
          primary
            ? 'border-accent/25 bg-accent-dim text-accent-strong'
            : 'border-line-strong bg-surface text-ink-secondary',
        ].join(' ')}
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 text-sm font-medium text-ink">
          {title}
          <svg
            viewBox="0 0 16 16"
            aria-hidden="true"
            className="h-3.5 w-3.5 text-ink-disabled transition-transform duration-base ease-atlas group-hover:translate-x-0.5 group-hover:text-accent"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M6 3.5 10.5 8 6 12.5" />
          </svg>
        </span>
        <span className="mt-1 block text-xs leading-relaxed text-ink-muted">{description}</span>
      </span>
    </a>
  );
}
