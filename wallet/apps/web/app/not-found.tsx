import Link from 'next/link';

/**
 * The App Router's 404 boundary.
 *
 * Required, not decorative: without it Next.js falls back to the Pages Router
 * error page during prerender, which has no `_document` in an app-router
 * project and fails the build with "<Html> should not be imported outside of
 * pages/_document". The error names a file that has nothing to do with the
 * cause, which is what makes it worth a comment.
 */
export default function NotFound() {
  return (
    <div className="mx-auto max-w-md py-24 text-center">
      {/*
        404 for a page that exists but is not yours, too — never 403. A 403
        confirms the route exists, which is a disclosure in itself.
      */}
      <p className="font-mono text-xs text-ink-muted">404</p>
      <h1 className="mt-4 text-xl font-semibold tracking-[-0.01em] text-ink">Page not found</h1>
      <p className="mx-auto mt-2.5 max-w-sm text-sm leading-relaxed text-ink-muted">
        That page does not exist, or you do not have access to it.
      </p>
      <Link
        href="/"
        className="mt-7 inline-flex items-center gap-1.5 text-sm text-accent transition-colors duration-micro ease-atlas hover:text-accent-strong"
      >
        Go back
      </Link>
    </div>
  );
}
