'use client';

import type { ReactNode } from 'react';

/**
 * Presentation-only primitives (rules 163, 166).
 *
 * Nothing here fetches, decides, or knows about a domain type. Phase 2 and 3
 * compose their deposit and withdrawal screens out of these rather than growing
 * a second set — which is why they exist now, before there is much to show.
 */

export function Button({
  children,
  variant = 'primary',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger';
}) {
  const styles = {
    primary: 'bg-accent text-white hover:opacity-90',
    secondary: 'border border-line text-ink hover:bg-line/30',
    danger: 'border border-red-300 text-red-700 hover:bg-red-50',
  }[variant];

  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${styles} ${props.className ?? ''}`}
    >
      {children}
    </button>
  );
}

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
      <span className="block text-sm font-medium text-ink">{label}</span>
      {children}
      {hint !== undefined && error === undefined && (
        <span className="block text-xs text-muted">{hint}</span>
      )}
      {error !== undefined && <span className="block text-xs text-red-600">{error}</span>}
    </label>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-accent ${props.className ?? ''}`}
    />
  );
}

export function Card({
  title,
  description,
  children,
}: {
  title?: string | undefined;
  description?: string | undefined;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-line bg-surface p-5">
      {title !== undefined && <h2 className="text-base font-semibold text-ink">{title}</h2>}
      {description !== undefined && <p className="mt-1 text-sm text-muted">{description}</p>}
      <div className={title !== undefined ? 'mt-4' : ''}>{children}</div>
    </section>
  );
}

export function StatusBadge({
  tone,
  children,
}: {
  tone: 'neutral' | 'good' | 'warn' | 'bad';
  children: ReactNode;
}) {
  const styles = {
    neutral: 'bg-line/50 text-muted',
    good: 'bg-emerald-100 text-emerald-800',
    warn: 'bg-amber-100 text-amber-800',
    bad: 'bg-red-100 text-red-800',
  }[tone];
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${styles}`}>
      {children}
    </span>
  );
}

/**
 * Honest empty states (rules 156-157).
 *
 * Phase 1's dashboard, wallet, and activity pages have nothing to show, and
 * they say so. They do NOT show a plausible-looking balance or a sample
 * transaction — in a wallet, a number that looks real and is not is worse than
 * no number at all.
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
    <div className="rounded-lg border border-dashed border-line px-6 py-12 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted">{body}</p>
      {phase !== undefined && (
        <p className="mt-4 text-xs uppercase tracking-wide text-muted">Arrives in {phase}</p>
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
      className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
    >
      <p>{message}</p>
      {correlationId != null && (
        // rule 167 — the user can quote this and it ties straight to the logs.
        <p className="mt-1 font-mono text-xs opacity-70">Reference: {correlationId}</p>
      )}
    </div>
  );
}

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-md rounded-lg border border-line bg-surface p-5"
      >
        <div className="flex items-start justify-between gap-4">
          <h3 className="text-base font-semibold text-ink">{title}</h3>
          <button onClick={onClose} aria-label="Close" className="text-muted hover:text-ink">
            ✕
          </button>
        </div>
        <div className="mt-4">{children}</div>
      </div>
    </div>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <p className="text-sm text-muted" role="status">
      {label}
    </p>
  );
}
