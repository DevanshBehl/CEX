export interface ConfigIssue {
  readonly variable: string;
  readonly problem: string;
}

/**
 * Carries variable NAMES and the reason they failed — never their values
 * (prompt_phase1.md rule 61). A config error is frequently the first thing
 * pasted into a chat or a ticket; it must be safe to paste.
 */
export class ConfigValidationError extends Error {
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    super(`Invalid configuration (${issues.length} problem${issues.length === 1 ? '' : 's'})`);
    this.name = 'ConfigValidationError';
    this.issues = issues;
  }

  report(): string {
    const lines = [
      '',
      '  ✗ Configuration is invalid. The process cannot start.',
      '',
      ...this.issues.map((i) => `    ${i.variable}: ${i.problem}`),
      '',
      '  See .env.example for the full list of required variables.',
      '  (Values are never printed here — only names and reasons.)',
      '',
    ];
    return lines.join('\n');
  }
}
