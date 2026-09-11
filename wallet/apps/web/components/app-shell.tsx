'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useSession } from '@/hooks/use-session';
import { Button } from './ui';

const NAV = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/deposit', label: 'Deposit' },
  { href: '/withdraw', label: 'Withdraw' },
  { href: '/activity', label: 'Activity' },
  { href: '/security', label: 'Security' },
  { href: '/profile', label: 'Profile' },
] as const;

const PUBLIC_ROUTES = new Set(['/', '/login', '/register']);

export function AppShell({ children }: { children: React.ReactNode }) {
  const { state, signOut } = useSession();
  const pathname = usePathname();
  const router = useRouter();

  const isPublic = PUBLIC_ROUTES.has(pathname);

  if (state.status === 'loading') {
    return <main className="p-8 text-sm text-muted">Loading…</main>;
  }

  // A client-side redirect for UX only. It is NOT a security control — every
  // protected endpoint is enforced server-side, and this component holds no
  // authorization decision (rule 204).
  if (state.status === 'anonymous' && !isPublic) {
    return (
      <main className="mx-auto max-w-md p-8">
        <p className="text-sm text-muted">You need to sign in to view this page.</p>
        <div className="mt-4">
          <Button onClick={() => router.push('/login')}>Go to sign in</Button>
        </div>
      </main>
    );
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <Link
            href={state.status === 'authenticated' ? '/dashboard' : '/'}
            className="font-semibold"
          >
            Wallet
          </Link>

          {state.status === 'authenticated' && (
            <>
              <nav className="hidden gap-1 sm:flex">
                {NAV.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`rounded-md px-3 py-1.5 text-sm ${
                      pathname === item.href ? 'bg-line/60 text-ink' : 'text-muted hover:text-ink'
                    }`}
                  >
                    {item.label}
                  </Link>
                ))}
              </nav>
              <Button
                variant="secondary"
                onClick={async () => {
                  await signOut();
                  router.push('/login');
                }}
              >
                Sign out
              </Button>
            </>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>

      <footer className="mx-auto max-w-5xl px-6 pb-10 text-xs text-muted">
        Educational project — not audited, not for real funds.
      </footer>
    </div>
  );
}
