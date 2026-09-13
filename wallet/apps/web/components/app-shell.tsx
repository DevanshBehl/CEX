'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useSession } from '@/hooks/use-session';
import { Button } from './ui';
import { Wordmark, Mark } from './brand';
import { useCapabilities } from '@/features/platform/use-capabilities';
import { NetworkSwitcher } from './network-switcher';
import { useTheme } from '@/hooks/use-theme';

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
  sun: 'M12 3v2M12 19v2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M3 12h2M19 12h2M5.6 18.4 7 17M17 7l1.4-1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z',
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

const PUBLIC_NAV = [
  { href: '/#product', label: 'Product' },
  { href: '/#how-it-works', label: 'How it works' },
  { href: '/#security', label: 'Security' },
  { href: '/#roadmap', label: 'Roadmap' },
  { href: '/#faq', label: 'FAQ' },
] as const;

const FOOTER_COLUMNS = [
  {
    title: 'Product',
    links: [
      { href: '/#product', label: 'Atlas Custody' },
      { href: '/#roadmap', label: 'Atlas Exchange' },
      { href: '/#how-it-works', label: 'How it works' },
    ],
  },
  {
    title: 'Trust',
    links: [
      { href: '/#security', label: 'Security model' },
      { href: '/#faq', label: 'FAQ' },
    ],
  },
  {
    title: 'Account',
    links: [
      { href: '/register', label: 'Create an account' },
      { href: '/login', label: 'Sign in' },
    ],
  },
] as const;

function NavIcon({ d, className = 'h-[15px] w-[15px]' }: { d: string; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`${className} shrink-0`}
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
        'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[12.5px]',
        'transition-colors duration-micro ease-atlas',
        // Where you are is a filled row, not an accent: the accent is kept for
        // the one action on the page (§6).
        active
          ? 'bg-surface-active font-semibold text-ink'
          : 'font-medium text-ink-secondary hover:bg-surface-hover hover:text-ink',
      ].join(' ')}
    >
      <NavIcon d={icon} />
      {label}
    </Link>
  );
}

function ThemeToggle() {
  const { theme, toggle } = useTheme();
  return (
    <button
      type="button"
      onClick={toggle}
      title="Toggle theme"
      aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      className="grid h-[30px] w-[30px] place-items-center rounded-md border border-line bg-surface text-ink-secondary transition-colors duration-micro ease-atlas hover:border-line-emphasis hover:text-ink"
    >
      <NavIcon d={theme === 'dark' ? ICONS.sun : ICONS.moon} className="h-3.5 w-3.5" />
    </button>
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
        <Mark className="h-7 w-7 animate-pulse-soft" />
      </main>
    );
  }

  // A client-side redirect for UX only. It is NOT a security control — every
  // protected endpoint is enforced server-side, and this component holds no
  // authorization decision (rule 204).
  if (state.status === 'anonymous' && !isPublic) {
    return (
      <main className="flex min-h-screen items-center justify-center px-6">
        <div className="atlas-raised w-full max-w-sm rounded-lg p-7 text-center">
          <p className="text-sm text-ink-secondary">You need to sign in to view this page.</p>
          <div className="mt-5">
            <Button onClick={() => router.push('/login')}>Go to sign in</Button>
          </div>
        </div>
      </main>
    );
  }

  /*
    Public pages are always dark, whatever the console theme is set to: they
    are the front door, not a workspace. `data-theme` on the wrapper re-scopes
    every token for the subtree, so no public component knows about it.
  */
  // The landing page keeps its public frame even for a signed-in visitor: it
  // is a page about the product, not a page in the console.
  if (state.status !== 'authenticated' || pathname === '/') {
    const signedIn = state.status === 'authenticated';
    return (
      <div data-theme="dark" className="flex min-h-screen flex-col bg-background text-ink">
        <header className="sticky top-0 z-40 border-b border-line bg-background/80 backdrop-blur-md">
          <div className="mx-auto flex h-[60px] w-full max-w-[1240px] items-center gap-8 px-6 lg:px-10">
            <Link href="/" className="rounded-sm">
              <Wordmark />
            </Link>

            <nav aria-label="Site" className="hidden items-center gap-6 md:flex">
              {PUBLIC_NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="text-[13px] font-medium text-ink-muted transition-colors duration-micro hover:text-ink"
                >
                  {item.label}
                </Link>
              ))}
            </nav>

            <div className="ml-auto flex items-center gap-2">
              <NetworkSwitcher />
              {signedIn ? (
                <Link href="/dashboard">
                  <Button size="sm">Open dashboard</Button>
                </Link>
              ) : (
                pathname === '/' && (
                  <>
                    <Link href="/login" className="hidden sm:block">
                      <Button variant="ghost" size="sm">
                        Sign in
                      </Button>
                    </Link>
                    <Link href="/register">
                      <Button size="sm">Get started</Button>
                    </Link>
                  </>
                )
              )}
            </div>
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1240px] flex-1 px-6 lg:px-10">{children}</main>

        <footer className="border-t border-line bg-background-subtle">
          <div className="mx-auto grid w-full max-w-[1240px] gap-10 px-6 py-14 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr] lg:px-10">
            <div className="max-w-xs">
              <Wordmark />
              <p className="mt-4 text-[13px] leading-relaxed text-ink-muted">
                The custody layer of a crypto exchange — threshold keys, a double-entry ledger and
                passkey sign-in.
              </p>
            </div>
            {FOOTER_COLUMNS.map((column) => (
              <div key={column.title}>
                <p className="text-xs font-semibold text-ink">{column.title}</p>
                <ul className="mt-4 space-y-2.5">
                  {column.links.map((link) => (
                    <li key={link.label}>
                      <Link
                        href={link.href}
                        className="text-[13px] text-ink-muted transition-colors duration-micro hover:text-ink"
                      >
                        {link.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <div className="border-t border-line">
            <div className="mx-auto flex w-full max-w-[1240px] flex-wrap items-center justify-between gap-3 px-6 py-5 text-xs text-ink-disabled lg:px-10">
              <span>Educational project — not audited, not for real funds.</span>
              <span className="font-mono">Atlas · Solana devnet</span>
            </div>
          </div>
        </footer>
      </div>
    );
  }

  const signing = capabilities?.signing.mode;
  const signingHealthy = signing !== undefined && signing !== 'mock';
  /*
    Three states, not two.

    This tested `=== 'single-key-mpc'` and so labelled a 3-of-5 deployment
    "Mock signing" — understating, which is the safe direction, and still a
    false statement about custody in a badge that is on screen permanently.
  */
  const signingLabel =
    signing === 'threshold-mpc'
      ? '3-of-5 signing'
      : signing === 'single-key-mpc'
        ? 'MPC signing'
        : 'Mock signing';

  return (
    <div className="flex min-h-screen flex-col">
      {/*
        One top bar across the full width, then sidebar and content below it —
        the console layout. The bar holds what must be visible on every page:
        which network, how signing is protected, and who is signed in.
      */}
      <header className="sticky top-0 z-40 border-b border-line bg-surface">
        <div className="flex h-topbar items-center gap-4 px-4">
          <Link href="/dashboard" className="shrink-0 rounded-sm lg:w-[204px]">
            <Wordmark />
          </Link>

          <div className="ml-auto flex items-center gap-2.5">
            {/*
              WHICH CHAIN, in the top bar, on every page (ADR-0021).

              Beside the account rather than buried in settings: the cost of
              mistaking devnet for mainnet is asymmetric and irreversible in
              one direction, so it belongs where it is read without looking
              for it.
            */}
            <NetworkSwitcher />
            <span
              className={[
                'hidden items-center gap-1.5 rounded-md border px-2 py-1 text-[11.5px] font-medium md:inline-flex',
                signingHealthy
                  ? 'border-success/30 bg-success-dim text-success'
                  : 'border-warning/30 bg-warning-dim text-warning',
              ].join(' ')}
            >
              <span
                aria-hidden="true"
                className={`h-1.5 w-1.5 animate-pulse-soft rounded-full ${signingHealthy ? 'bg-success' : 'bg-warning'}`}
              />
              {signingLabel}
            </span>
            <ThemeToggle />
            {/*
              The account, identified by whatever it actually has. An account
              created with no email and no display name — which registration
              permits — has only its id, and showing a truncated id is more use
              than the word "Signed in", which tells the user nothing they did
              not already know.
            */}
            <span className="hidden items-center gap-2 sm:flex">
              <span
                aria-hidden="true"
                className="grid h-[30px] w-[30px] place-items-center rounded-md bg-ink text-[11px] font-semibold uppercase text-surface"
              >
                {(state.data.user.displayName ?? state.data.user.email ?? 'A').slice(0, 2)}
              </span>
              <span className="hidden font-mono text-[11.5px] text-ink-muted xl:inline">
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
          className="flex gap-1 overflow-x-auto border-t border-line px-3 py-2 lg:hidden"
          aria-label="Primary"
        >
          {[...NAV, ...ACCOUNT_NAV].map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={pathname === item.href ? 'page' : undefined}
              className={[
                'whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium transition-colors duration-micro ease-atlas',
                pathname === item.href ? 'bg-surface-active text-ink' : 'text-ink-secondary',
              ].join(' ')}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </header>

      <div className="flex min-h-0 flex-1">
        {/*
          A persistent sidebar rather than more top-bar items.
          §33: navigation should be predictable and always available. A custody
          console is a place you work in, not a page you read.
        */}
        <aside className="sticky top-topbar hidden h-[calc(100vh-var(--atlas-topbar-height))] w-sidebar shrink-0 flex-col border-r border-line bg-surface px-2.5 py-3 lg:flex">
          <nav className="flex-1 space-y-5" aria-label="Primary">
            <div className="space-y-0.5">
              {NAV.map((item) => (
                <NavLink key={item.href} {...item} active={pathname === item.href} />
              ))}
            </div>

            <div className="space-y-0.5">
              <p className="px-2.5 pb-1 text-[11px] font-semibold text-ink-disabled">Account</p>
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
          <div className="rounded-lg border border-line bg-background-subtle p-3">
            <div className="flex justify-between text-[11px] font-medium text-ink-muted">
              <span>Signing</span>
              <span className="font-mono">
                {signing === 'threshold-mpc'
                  ? '3-of-5'
                  : signing === 'single-key-mpc'
                    ? '1-of-1'
                    : 'mock'}
              </span>
            </div>
            <div className="mt-2 flex gap-[3px]" aria-hidden="true">
              {Array.from({ length: signing === 'threshold-mpc' ? 5 : 1 }, (_, index) => (
                <span
                  key={index}
                  className={`h-1 flex-1 rounded-sm ${signingHealthy ? 'bg-success' : 'bg-warning'}`}
                />
              ))}
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-ink-muted">
              {signingLabel}. Not audited. Not production custody.
            </p>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <main className="w-full max-w-[1180px] flex-1 animate-fade px-6 pb-10 pt-[22px]">
            {children}
          </main>

          <footer className="border-t border-line px-6 py-5">
            <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-ink-muted">
              <span>Educational project — not audited, not for real funds.</span>
              <span className="font-mono">Atlas</span>
            </div>
          </footer>
        </div>
      </div>
    </div>
  );
}
