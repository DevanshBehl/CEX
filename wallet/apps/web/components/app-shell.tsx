'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useSession } from '@/hooks/use-session';
import { Button } from './ui';
import { Wordmark, Mark } from './brand';
import { useCapabilities } from '@/features/platform/use-capabilities';
import { NetworkSwitcher } from './network-switcher';

/**
 * Icons, inline.
 *
 * A navigation icon set is six paths; an icon library is a dependency with a
 * bundle cost and its own naming conventions. These are stroke-only on
 * `currentColor` so they inherit the nav's active and muted states for free.
 */
const ICONS = {
  dashboard: 'M3.5 3.5h6v6h-6zM14.5 3.5h6v6h-6zM3.5 14.5h6v6h-6zM14.5 14.5h6v6h-6z',
  deposit: 'M12 4v12m0 0 4.5-4.5M12 16l-4.5-4.5M4 20h16',
  withdraw: 'M12 20V8m0 0L7.5 12.5M12 8l4.5 4.5M4 4h16',
  activity: 'M3 12h4l3-7 4 14 3-7h4',
  security: 'M12 3 4.5 6v6c0 4.2 3 7.6 7.5 9 4.5-1.4 7.5-4.8 7.5-9V6z',
  profile: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4.5 20.5a7.5 7.5 0 0 1 15 0',
} as const;

const NAV = [
  { href: '/dashboard', label: 'Dashboard', icon: ICONS.dashboard },
  { href: '/deposit', label: 'Deposit', icon: ICONS.deposit },
  { href: '/withdraw', label: 'Withdraw', icon: ICONS.withdraw },
  { href: '/activity', label: 'Activity', icon: ICONS.activity },
] as const;

const ACCOUNT_NAV = [
  { href: '/security', label: 'Security', icon: ICONS.security },
  { href: '/profile', label: 'Profile', icon: ICONS.profile },
] as const;

const PUBLIC_ROUTES = new Set(['/', '/login', '/register']);

function NavIcon({ d }: { d: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-[18px] w-[18px] shrink-0"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

function NavLink({
  href,
  label,
  icon,
  active,
}: {
  href: string;
  label: string;
  icon: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={[
        'group relative flex items-center gap-3 rounded-md px-3 py-2 text-sm',
        'transition-colors duration-micro ease-atlas',
        active
          ? 'bg-surface text-ink'
          : 'text-ink-muted hover:bg-surface/60 hover:text-ink-secondary',
      ].join(' ')}
    >
      {/*
        The accent marks exactly one thing: where you are (§6). A 2px rail on
        the leading edge rather than a filled pill, so the sidebar stays a
        column of type rather than a stack of buttons.
      */}
      {active && (
        <span
          aria-hidden="true"
          className="absolute -left-px top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-accent-strong"
        />
      )}
      <span className={active ? 'text-accent-strong' : ''}>
        <NavIcon d={icon} />
      </span>
      {label}
    </Link>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { state, signOut } = useSession();
  const pathname = usePathname();
  const router = useRouter();
  const capabilities = useCapabilities();

  const isPublic = PUBLIC_ROUTES.has(pathname);

  if (state.status === 'loading') {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <Mark className="h-7 w-7 animate-pulse-soft text-accent-strong" />
      </main>
    );
  }

  // A client-side redirect for UX only. It is NOT a security control — every
  // protected endpoint is enforced server-side, and this component holds no
  // authorization decision (rule 204).
  if (state.status === 'anonymous' && !isPublic) {
    return (
      <main className="flex min-h-screen items-center justify-center px-6">
        <div className="atlas-raised w-full max-w-sm rounded-xl p-7 text-center">
          <p className="text-sm text-ink-secondary">You need to sign in to view this page.</p>
          <div className="mt-5">
            <Button onClick={() => router.push('/login')}>Go to sign in</Button>
          </div>
        </div>
      </main>
    );
  }

  // Public pages are a single centred column: no sidebar to navigate yet.
  if (state.status !== 'authenticated') {
    return (
      <div className="relative z-10 flex min-h-screen flex-col">
        <header className="border-b border-line">
          <div className="mx-auto flex h-16 w-full max-w-[1200px] items-center justify-between px-6 lg:px-10">
            <Link href="/" className="rounded-sm">
              <Wordmark />
            </Link>
            <div className="ml-auto flex items-center gap-3">
              <NetworkSwitcher />
              {!isPublic ||
                (pathname === '/' && (
                  <Link href="/login">
                    <Button variant="secondary" size="sm">
                      Sign in
                    </Button>
                  </Link>
                ))}
            </div>
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1200px] flex-1 px-6 lg:px-10">{children}</main>
        <footer className="border-t border-line">
          <div className="mx-auto flex w-full max-w-[1200px] items-center justify-between gap-3 px-6 py-6 text-xs text-ink-muted lg:px-10">
            <span>Educational project — not audited, not for real funds.</span>
            <span className="font-mono text-2xs uppercase tracking-[0.16em]">Atlas</span>
          </div>
        </footer>
      </div>
    );
  }

  return (
    <div className="relative z-10 flex min-h-screen">
      {/*
        A persistent sidebar rather than a top bar.
        §33: navigation should be predictable and always available. A custody
        console is a place you work in, not a page you read, and the sidebar is
        what makes it read that way — it also leaves the full page width for
        data rather than spending it on a nav strip.
      */}
      <aside className="fixed inset-y-0 left-0 hidden w-sidebar flex-col border-r border-line bg-background-subtle lg:flex">
        <div className="flex h-16 items-center px-5">
          <Link href="/dashboard" className="rounded-sm">
            <Wordmark />
          </Link>
        </div>

        <nav className="flex-1 space-y-6 px-3 py-4" aria-label="Primary">
          <div className="space-y-0.5">
            {NAV.map((item) => (
              <NavLink key={item.href} {...item} active={pathname === item.href} />
            ))}
          </div>

          <div className="space-y-0.5">
            <p className="px-3 pb-1.5 text-2xs font-medium uppercase tracking-wider text-ink-disabled">
              Account
            </p>
            {ACCOUNT_NAV.map((item) => (
              <NavLink key={item.href} {...item} active={pathname === item.href} />
            ))}
          </div>
        </nav>

        {/*
          Custody status, permanently visible.

          master-prompt rule 8: nobody should be able to assume this is
          production custody. On a page they visit once that is a notice; in
          the sidebar it is a fact of the product. The wording comes from the
          platform (rules 236-237), never from hardcoded copy that can go stale.
        */}
        <div className="shrink-0 border-t border-line p-3">
          <div className="rounded-md bg-surface/60 px-3 py-2.5">
            {/*
              Three states, not two.
              
              This tested `=== 'single-key-mpc'` and so labelled a 3-of-5
              deployment "Mock signing" — understating, which is the safe
              direction, and still a false statement about custody in a badge
              that is on screen permanently.
            */}
            <p className="flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wider text-ink-muted">
              <span
                aria-hidden="true"
                className={`h-1.5 w-1.5 rounded-full ${
                  capabilities?.signing.mode === 'mock' || capabilities === undefined
                    ? 'bg-warning'
                    : 'bg-success'
                }`}
              />
              {capabilities?.signing.mode === 'threshold-mpc'
                ? '3-of-5 signing'
                : capabilities?.signing.mode === 'single-key-mpc'
                  ? 'MPC signing'
                  : 'Mock signing'}
            </p>
            <p className="mt-1.5 text-2xs leading-relaxed text-ink-disabled">
              Not audited. Not production custody.
            </p>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col lg:pl-sidebar">
        {/* Sticky, blurred — one of the few places §36 allows glass. */}
        <header className="sticky top-0 z-40 border-b border-line bg-background/85 backdrop-blur-xl">
          <div className="flex h-16 items-center gap-4 px-6 lg:px-10">
            <Link href="/dashboard" className="rounded-sm lg:hidden">
              <Wordmark />
            </Link>

            <div className="ml-auto flex items-center gap-3">
              {/*
                WHICH CHAIN, in the top bar, on every page (ADR-0021).

                Beside the account rather than buried in settings: the cost of
                mistaking devnet for mainnet is asymmetric and irreversible in
                one direction, so it belongs where it is read without looking
                for it.
              */}
              <NetworkSwitcher />
              {/*
                The account, identified by whatever it actually has. An account
                created with no email and no display name — which registration
                permits — has only its id, and showing a truncated id is more
                use than the word "Signed in", which tells the user nothing
                they did not already know.
              */}
              <span className="hidden items-center gap-2.5 sm:flex">
                <span
                  aria-hidden="true"
                  className="atlas-raised flex h-7 w-7 items-center justify-center rounded-full text-2xs font-semibold uppercase text-ink-secondary"
                >
                  {(state.data.user.displayName ?? state.data.user.email ?? 'A').slice(0, 1)}
                </span>
                <span className="font-mono text-2xs text-ink-muted">
                  {state.data.user.email ??
                    state.data.user.displayName ??
                    `${state.data.user.id.slice(0, 8)}…`}
                </span>
              </span>
              <Button
                variant="secondary"
                size="sm"
                onClick={async () => {
                  await signOut();
                  router.push('/login');
                }}
              >
                Sign out
              </Button>
            </div>
          </div>

          {/* Mobile navigation: the same destinations, scrollable (§38). */}
          <nav
            className="flex gap-1 overflow-x-auto border-t border-line px-4 py-2 lg:hidden"
            aria-label="Primary"
          >
            {[...NAV, ...ACCOUNT_NAV].map((item) => (
              <Link
                key={item.href}
                href={item.href}
                aria-current={pathname === item.href ? 'page' : undefined}
                className={[
                  'whitespace-nowrap rounded-md px-3 py-1.5 text-xs transition-colors duration-micro ease-atlas',
                  pathname === item.href ? 'bg-surface text-ink' : 'text-ink-muted',
                ].join(' ')}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </header>

        <main className="flex-1 px-6 py-8 lg:px-10 lg:py-10">{children}</main>

        <footer className="border-t border-line px-6 py-6 lg:px-10">
          <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-ink-muted">
            <span>Educational project — not audited, not for real funds.</span>
            <span className="font-mono text-2xs uppercase tracking-[0.16em]">Atlas</span>
          </div>
        </footer>
      </div>
    </div>
  );
}
