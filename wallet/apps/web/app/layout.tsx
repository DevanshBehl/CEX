import type { Metadata } from 'next';
import { IBM_Plex_Mono, IBM_Plex_Sans } from 'next/font/google';
import { SessionProvider } from '@/hooks/use-session';
import { THEME_INIT_SCRIPT } from '@/hooks/use-theme';
import { NetworkProvider } from '@/features/network/network-context';
import { AppShell } from '@/components/app-shell';
import './globals.css';

/**
 * Typography (design.md §4).
 *
 * IBM Plex Sans for the interface, IBM Plex Mono for anything where alignment
 * carries meaning — balances, addresses, signatures, timestamps. One family in
 * two cuts, so figures in a table and the labels beside them share metrics.
 * Both are loaded as CSS variables so `tailwind.config.ts` can reference them
 * as tokens rather than hardcoding a family name in a component.
 *
 * `display: swap` because a custody dashboard that shows nothing while a font
 * downloads is worse than one that reflows.
 */
const sans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-sans',
  display: 'swap',
});

const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
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
    // `data-theme` is set by the init script before paint, so the server-rendered
    // attribute is expected to differ from the client's.
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-screen bg-background font-sans text-sm text-ink antialiased">
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
