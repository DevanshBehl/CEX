/**
 * Origin verification for state-changing requests (prompt_phase1.md rule 129).
 *
 * WHY `Origin` IS THE AUTHORITATIVE CHECK
 *
 * The web app and the API are separate origins by design (different ports in
 * development, typically different subdomains in deployment). That shapes what
 * this check can rely on:
 *
 *   - `Origin` is set by the browser on every cross-origin request and on every
 *     non-GET request. Page script cannot forge it. Comparing it to the one
 *     configured web origin is therefore a complete CSRF defence on its own: an
 *     attacker's page can cause a request, but it cannot make the browser lie
 *     about where that request came from.
 *
 *   - `Sec-Fetch-Site` is a WEAKER signal here, not a stronger one. Because
 *     "site" ignores the port, a request from localhost:3000 to localhost:4000
 *     arrives as `same-site`, not `same-origin` — and app.example.com to
 *     api.example.com does too. Requiring `same-origin` rejects every
 *     legitimate request in this topology, which is exactly what it did before
 *     the E2E suite caught it.
 *
 * So: `Origin` must match. `Sec-Fetch-Site` is used only to reject `none`,
 * which means a direct navigation or bookmark — never a legitimate state change.
 *
 * DEPLOYMENT CONSTRAINT: the session cookie is `SameSite=Strict`, so the
 * browser only attaches it when the API and the web app are the same *site*
 * (same registrable domain; port and subdomain do not matter). Serving them
 * from genuinely different domains would silently stop sending the cookie.
 * Keep them on one registrable domain.
 */
export type CsrfVerdict = { ok: true } | { ok: false; reason: string };

export interface CsrfCheckInput {
  readonly method: string;
  readonly origin: string | undefined;
  readonly secFetchSite: string | undefined;
  readonly expectedOrigin: string;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function checkCsrf(input: CsrfCheckInput): CsrfVerdict {
  if (SAFE_METHODS.has(input.method.toUpperCase())) return { ok: true };

  // A direct navigation is never a legitimate state change for this API.
  if (input.secFetchSite === 'none') return { ok: false, reason: 'sec_fetch_site_none' };

  // The authoritative check. Browser-set, unforgeable by page script.
  if (input.origin === undefined) return { ok: false, reason: 'origin_absent' };
  if (input.origin !== input.expectedOrigin) return { ok: false, reason: 'origin_mismatch' };

  return { ok: true };
}
