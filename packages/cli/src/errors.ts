import { ForgeError } from '@forge-fr/core';

export type CliErrorCode =
  | 'CLI_INVALID_ARGUMENT'
  | 'CLI_PATH_VIOLATION'
  | 'CLI_TEMPLATE_ERROR'
  | 'CLI_FILE_EXISTS'
  | 'CLI_EXECUTION_FAILED';

export class CliError extends ForgeError {
  public readonly cliCode: CliErrorCode;

  public constructor(
    cliCode: CliErrorCode,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, {
      code: cliCode,
      statusCode: 400,
      expose: true,
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
    });
    this.name = 'CliError';
    this.cliCode = cliCode;
  }
}
