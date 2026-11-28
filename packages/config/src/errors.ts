import { ConfigurationError } from '@forge-fr/core';

export interface ConfigValidationIssue {
  readonly path: string;
  readonly message: string;
  readonly isSecret: boolean;
}

/**
 * Thrown when startup or runtime environment configuration fails schema validation.
 * Guaranteed never to include raw secret values in `.message` or `.details`.
 */
export class ConfigValidationError extends ConfigurationError {
  public readonly issues: readonly ConfigValidationIssue[];

  public constructor(issues: readonly ConfigValidationIssue[], message?: string) {
    const formattedLines = issues.map((issue) => {
      const keyLabel = issue.path || '<root>';
      const suffix = issue.isSecret ? ' [secret value redacted]' : '';
      return `  - ${keyLabel}: ${issue.message}${suffix}`;
    });

    const summary =
      message ??
      `Invalid configuration (${issues.length} ${issues.length === 1 ? 'issue' : 'issues'}):\n${formattedLines.join('\n')}`;

    super(summary, {
      details: {
        issueCount: issues.length,
        issues: issues.map((i) => ({
          path: i.path,
          message: i.message,
          isSecret: i.isSecret,
        })),
      },
    });
    this.name = 'ConfigValidationError';
    this.issues = Object.freeze(issues.map((i) => Object.freeze({ ...i })));
  }
}
