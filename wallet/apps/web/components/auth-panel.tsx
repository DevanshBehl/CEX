import type { ReactNode } from 'react';
import { Mark } from './brand';

/**
 * The frame both auth views share (design.md §49: extract a shared primitive
 * rather than duplicating visual logic).
 *
 * Sign-in and registration were two copies of the same centred card. They are
 * the first impression of the product and the place a user decides whether it
 * looks like it can be trusted with money — so they get deliberate vertical
 * centring, the mark, a real measure, and one accent-lit surface, defined once.
 */
export function AuthPanel({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <div className="relative flex min-h-[70vh] items-center justify-center">
      <div className="atlas-glow" aria-hidden="true" />

      <div className="relative w-full max-w-[400px] animate-fade-up">
        <div className="mb-8 flex justify-center">
          <Mark className="h-7 w-7 text-accent" />
        </div>

        <div className="rounded-xl border border-line-strong bg-surface p-7 shadow-md">
          <h1 className="text-lg font-semibold tracking-[-0.01em] text-ink">{title}</h1>
          <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">{description}</p>
          <div className="mt-6">{children}</div>
        </div>

        <div className="mt-6 text-center text-sm text-ink-muted">{footer}</div>
      </div>
    </div>
  );
}
