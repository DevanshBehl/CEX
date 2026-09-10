/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The API is a separate origin; nothing is proxied, so CORS and the cookie
  // policy are exercised in development exactly as they are in production.
  transpilePackages: ['@wallet/types'],
  poweredByHeader: false,

  /**
   * Linting and type-checking are first-class Turbo tasks (`pnpm lint`,
   * `pnpm typecheck`) that cover every package, and CI gates on them.
   * Re-running them inside `next build` duplicates the work, reports the same
   * problems in a worse format, and makes the build sensitive to the
   * `include` paths Next.js rewrites into tsconfig.json as it alternates
   * between dev and build.
   */
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },
};

export default nextConfig;
