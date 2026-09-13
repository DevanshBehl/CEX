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
   * Solid, no glow: a lit button reads as marketing, a flat one as a control.
   */
  primary: 'bg-accent-strong text-on-accent hover:bg-accent-deep',
  secondary:
    'border border-line-strong bg-surface text-ink hover:border-line-emphasis hover:bg-surface-hover',
  ghost: 'text-ink-secondary hover:text-ink hover:bg-surface-active',
  danger: 'border border-danger/30 bg-danger-dim text-danger hover:border-danger/60',
} as const;

const BUTTON_SIZES = {
  sm: 'h-[30px] gap-1.5 px-3 text-xs',
  md: 'h-9 gap-2 px-4 text-sm',
  lg: 'h-10 gap-2 px-5 text-sm',
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
        'inline-flex items-center justify-center rounded-md font-semibold',
        // §26: every interaction gives feedback — a colour step on hover.
        'transition-colors duration-micro ease-atlas',
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
    <label className="block space-y-1.5">
      <span className="block text-xs font-semibold text-ink-secondary">{label}</span>
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
        'w-full rounded-md border border-line bg-background-subtle px-3 py-2.5',
        'text-sm text-ink placeholder:text-ink-disabled',
        'outline-none transition-colors duration-micro ease-atlas',
        'hover:border-line-strong',
        // A border colour change only, so the control does not shift by a
        // pixel when it takes focus.
        'focus:border-accent-strong',
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
        <header className="flex items-start justify-between gap-4 border-b border-line px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-ink">{title}</h2>
            {description !== undefined && (
              <p className="mt-1 text-xs text-ink-muted">{description}</p>
            )}
          </div>
          {action}
        </header>
      )}
      <div className="p-4">{children}</div>
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
    <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold text-ink">{title}</h1>
        {description !== undefined && (
          <p className="mt-1 max-w-2xl text-sm text-ink-muted">{description}</p>
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
      <dt className="text-xs font-medium text-ink-muted">{label}</dt>
      <dd className={`mt-1 truncate text-sm ${mono ? 'font-mono' : ''} ${tones[tone]}`}>{value}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status (§21)
// ---------------------------------------------------------------------------

/**
 * Status as a small tinted tag.
 *
 * Square-cornered and low-saturation: a tint and a hairline border in the
 * status colour, the word in its darker step. It stays legible in a dense
 * table on either theme without every row shouting equally loudly.
 */
export function StatusBadge({
  tone,
  children,
}: {
  tone: 'neutral' | 'good' | 'warn' | 'bad';
  children: ReactNode;
}) {
  const styles = {
    neutral: 'border-line bg-surface-active text-ink-secondary',
    good: 'border-success/30 bg-success-dim text-success',
    warn: 'border-warning/30 bg-warning-dim text-warning',
    bad: 'border-danger/30 bg-danger-dim text-danger',
  }[tone];

  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-sm border px-[7px] py-0.5 text-[10.5px] font-semibold leading-4 ${styles}`}
    >
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
        className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-surface-active"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-ink-muted" />
      </span>
      <p className="text-sm font-medium text-ink">{title}</p>
      <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-ink-muted">{body}</p>
      {phase !== undefined && (
        <p className="mt-4 inline-flex items-center rounded-sm border border-line bg-surface-active px-2 py-0.5 font-mono text-2xs text-ink-muted">
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
      className="rounded-md border border-danger/30 bg-danger-dim px-4 py-3 text-sm text-danger"
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
      className={`relative block overflow-hidden rounded bg-surface-active ${className}`}
    >
      <span className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-surface/60 to-transparent" />
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
      {/* Backdrop: a plain scrim — the dialog is the only thing to look at. */}
      <button
        aria-hidden="true"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 animate-fade cursor-default bg-scrim/50"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative w-full max-w-md animate-pop overflow-hidden rounded-xl border border-line bg-surface shadow-lg"
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-3.5">
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
 * A section of a page: a titled panel.
 *
 * The console is built from panels on a tinted page — a hairline-bordered
 * surface with its title in a header strip. Content inside a section should
 * NOT be another bordered card; use rows divided by hairlines instead, so a
 * page never reads as boxes inside boxes.
 */
export function Section({
  title,
  description,
  action,
  children,
  flush = false,
}: {
  title: string;
  description?: string | undefined;
  action?: ReactNode;
  children: ReactNode;
  /** Drop the body padding, for tables and row lists that run edge to edge. */
  flush?: boolean;
}) {
  return (
    <section className="atlas-raised overflow-hidden rounded-lg">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          {description !== undefined && (
            <p className="mt-0.5 text-xs text-ink-muted">{description}</p>
          )}
        </div>
        {action}
      </div>
      <div className={flush ? '' : 'p-4'}>{children}</div>
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
    neutral: 'border-line bg-surface text-ink-muted',
    accent: 'border-accent-strong/25 bg-accent-dim text-accent',
    warning: 'border-warning/30 bg-warning-dim text-warning',
  } as const;

  return (
    <aside className={`rounded-lg border ${tones[tone]} px-4 py-3.5`}>
      <p className="text-xs font-semibold">{label}</p>
      <p className="mt-1.5 text-sm font-semibold text-ink">{title}</p>
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
      {label !== undefined && <p className="text-xs font-medium text-ink-muted">{label}</p>}
      {loading ? (
        <Skeleton className="mt-2 h-9 w-40" />
      ) : (
        <p className="mt-1 flex items-baseline gap-2">
          <span className="font-mono text-[34px] font-semibold leading-10 tracking-[-0.02em] text-ink">
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
      className={`block break-all rounded-md border border-line bg-background-subtle px-3 py-2.5 font-mono text-sm text-ink ${className}`}
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
    <div className="atlas-raised rounded-lg px-4 py-3.5">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium text-ink-muted">{label}</p>
        {icon}
      </div>

      {loading ? (
        <Skeleton className="mt-2 h-7 w-32" />
      ) : (
        <p className="mt-1.5 flex items-baseline gap-1.5">
          <span
            className={`font-mono text-[19px] font-semibold leading-7 tracking-[-0.01em] ${valueTone}`}
          >
            {value}
          </span>
          {unit !== undefined && <span className="font-mono text-xs text-ink-muted">{unit}</span>}
        </p>
      )}

      {hint !== undefined && <div className="mt-1 text-xs text-ink-muted">{hint}</div>}
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
        'atlas-raised atlas-raised-hover group flex items-start gap-3.5 rounded-lg p-4',
        primary ? 'hover:!border-accent-strong' : '',
      ].join(' ')}
    >
      <span
        className={[
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-md',
          primary ? 'bg-accent-strong text-on-accent' : 'bg-surface-active text-ink-secondary',
        ].join(' ')}
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-ink">
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
