import { z } from 'zod';

export const dependencyStatusSchema = z.object({
  name: z.string(),
  status: z.enum(['up', 'down', 'degraded']),
  latencyMs: z.number().nonnegative().optional(),
  /** Safe summary only — never a driver message or connection string. */
  detail: z.string().optional(),
});
export type DependencyStatus = z.infer<typeof dependencyStatusSchema>;

export const liveResponseSchema = z.object({
  status: z.literal('ok'),
  uptimeSeconds: z.number().nonnegative(),
});
export type LiveResponse = z.infer<typeof liveResponseSchema>;

/**
 * Each dependency reports individually rather than collapsing into one boolean
 * (prompt_phase1.md rule 152). The array shape is what lets Phase 4 add Solana
 * RPC and the MPC service without changing the contract (rule 153).
 */
export const readyResponseSchema = z.object({
  status: z.enum(['ok', 'degraded', 'down']),
  dependencies: z.array(dependencyStatusSchema),
});
export type ReadyResponse = z.infer<typeof readyResponseSchema>;
