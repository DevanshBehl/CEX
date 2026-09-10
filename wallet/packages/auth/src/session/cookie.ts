export interface CookiePolicy {
  readonly name: string;
  readonly secure: boolean;
  readonly maxAgeSeconds: number;
}

export interface CookieAttributes {
  readonly httpOnly: true;
  readonly secure: boolean;
  readonly sameSite: 'strict';
  readonly path: '/';
  readonly maxAge: number;
}

/**
 * Session cookie attributes (rule 124).
 *
 *   httpOnly           — no JavaScript read path, so an XSS bug cannot simply
 *                        exfiltrate the session.
 *   secure             — never sent over plaintext HTTP (relaxed on localhost
 *                        only, where there is no network to sniff).
 *   sameSite: strict   — the browser will not attach this cookie to any
 *                        cross-site request at all. Combined with the origin
 *                        check in the CSRF guard, that is two independent
 *                        defences (rule 129).
 *   path: '/'          — scoped to the app, not to a subpath that a future
 *                        route move would silently escape.
 *
 * There is deliberately no JavaScript-readable duplicate of this cookie. A
 * mirrored "is logged in" cookie is a standard convenience and a standard way
 * to leak session state into the DOM; the client learns it is authenticated by
 * calling /auth/session, like everything else.
 */
export function sessionCookieAttributes(policy: CookiePolicy): CookieAttributes {
  return {
    httpOnly: true,
    secure: policy.secure,
    sameSite: 'strict',
    path: '/',
    maxAge: policy.maxAgeSeconds,
  };
}

export function clearedCookieAttributes(policy: CookiePolicy): CookieAttributes {
  return { ...sessionCookieAttributes(policy), maxAge: 0 };
}
