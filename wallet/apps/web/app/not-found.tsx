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
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="text-lg font-semibold">Page not found</h1>
      <p className="mt-2 text-sm text-muted">
        That page does not exist, or you do not have access to it.
      </p>
      <Link href="/" className="mt-6 inline-block text-sm text-accent underline">
        Go back
      </Link>
    </div>
  );
}
