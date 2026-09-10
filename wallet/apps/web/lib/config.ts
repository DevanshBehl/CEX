import { z } from 'zod';

/**
 * THE ONLY FILE IN apps/web THAT READS process.env.
 *
 * The monorepo rule is "process.env is read in exactly one place"
 * (prompt_phase1.md rules 56-57), and `packages/config` is that place — for
 * the server. The browser cannot use it: Next.js inlines `NEXT_PUBLIC_*` at
 * build time and a server config module would drag server-only schema and
 * secrets into the client bundle.
 *
 * So the web app gets its own single reader, exempted by name in
 * eslint.config.js, holding the same two properties that matter: validated at
 * load, and nothing here is a secret. Anything in this file ships to every
 * visitor's browser (rule 64).
 */
const publicEnvSchema = z.object({
  NEXT_PUBLIC_API_URL: z.string().url().default('http://localhost:4000'),
});

const parsed = publicEnvSchema.safeParse({
  // Referenced statically, not via a computed key — Next.js can only inline
  // literal `process.env.NEXT_PUBLIC_X` references.
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
});

if (!parsed.success) {
  throw new Error(
    `Invalid public configuration: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`,
  );
}

export const publicConfig = Object.freeze({
  apiBaseUrl: parsed.data.NEXT_PUBLIC_API_URL,
});
