'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * The console theme: light or dark (globals.css).
 *
 * The choice is a per-browser convenience, so it lives in localStorage and is
 * applied as `data-theme` on `<html>`. `THEME_INIT_SCRIPT` runs before first
 * paint so a dark-theme user never sees a white flash; this hook only reads
 * back what that script decided and writes changes.
 */
export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'atlas-theme';

/**
 * Inlined into `<head>` by the root layout. A stored choice wins; with none,
 * the operating system's preference decides. Wrapped in try/catch because
 * storage can throw (private windows, blocked site data) and a theme is never
 * worth a broken page.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem('${STORAGE_KEY}');if(t!=='light'&&t!=='dark'){t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme='light'}})();`;

function current(): Theme {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

export function useTheme() {
  // Starts as 'light' on the server and the first client render, then syncs to
  // what the init script applied — so hydration never mismatches.
  const [theme, setThemeState] = useState<Theme>('light');

  useEffect(() => {
    setThemeState(current());
  }, []);

  const setTheme = useCallback((next: Theme) => {
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Not persisted; still applied for this page view.
    }
    setThemeState(next);
  }, []);

  const toggle = useCallback(() => {
    setTheme(current() === 'dark' ? 'light' : 'dark');
  }, [setTheme]);

  return { theme, setTheme, toggle };
}
