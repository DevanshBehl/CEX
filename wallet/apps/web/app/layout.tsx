import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import { SessionProvider } from '@/hooks/use-session';
import { NetworkProvider } from '@/features/network/network-context';
import { AppShell } from '@/components/app-shell';
import './globals.css';

/**
 * Typography (design.md §4).
 *
 * Inter for the interface, a mono for anything where alignment carries meaning
 * — balances, addresses, signatures, timestamps. Both are loaded as CSS
 * variables so `tailwind.config.ts` can reference them as tokens rather than
 * hardcoding a family name in a component.
 *
 * `display: swap` because a custody dashboard that shows nothing while a font
 * downloads is worse than one that reflows.
 */
const sans = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
});

const mono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    default: 'Atlas Wallet',
    template: '%s · Atlas',
  },
  description: 'Custodial infrastructure for digital assets.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body className="min-h-screen bg-background font-sans text-ink antialiased">
        {/*
          The signature grid (§9), painted once behind the whole application
          rather than per-page. It is fixed, so it stays put while content
          scrolls over it — the interface reads as sitting ON a surface rather
          than carrying a patterned background around with it.
        */}
        <div className="atlas-grid" aria-hidden="true" />

        {/*
          The network wraps the session, not the other way round: which chain
          the interface is about is decided before anyone signs in — the
          switcher is populated from the unauthenticated /capabilities — and
          every authenticated request carries it (ADR-0021).
        */}
        <NetworkProvider>
          <SessionProvider>
            <AppShell>{children}</AppShell>
          </SessionProvider>
        </NetworkProvider>
      </body>
    </html>
  );
}
