import { FORBIDDEN_FIELDS, LOGGABLE_FIELDS } from './allowlist.js';

export type LogValue = string | number | boolean | null | readonly (string | number)[];
export type LogFields = Readonly<Record<string, unknown>>;

export interface SanitizedFields {
  readonly fields: Record<string, LogValue>;
  readonly droppedFields: number;
}

function isLoggableValue(value: unknown): value is LogValue {
  if (value === null) return true;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return true;
  if (Array.isArray(value)) {
    return value.every((v) => typeof v === 'string' || typeof v === 'number');
  }
  return false;
}

/**
 * Drops every field that is not explicitly allowlisted, and every value that is
 * not a primitive (rule 73).
 *
 * The value check is the second half of the guarantee: allowlisting `event` and
 * then passing a whole request object under it would tunnel arbitrary content
 * past the key check. Only flat primitives survive, so there is nowhere for a
 * secret to hide in a nested structure.
 *
 * Dropped fields are counted rather than silently discarded, so a developer who
 * expected to see something and does not gets a visible reason.
 */
export function sanitizeFields(input: LogFields | undefined): SanitizedFields {
  if (!input) return { fields: {}, droppedFields: 0 };

  const fields: Record<string, LogValue> = {};
  let droppedFields = 0;

  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (FORBIDDEN_FIELDS.has(key) || !LOGGABLE_FIELDS.has(key) || !isLoggableValue(value)) {
      droppedFields += 1;
      continue;
    }
    fields[key] = value;
  }

  return { fields, droppedFields };
}
