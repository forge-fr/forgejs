import { isForgeError } from '@forge-fr/core';
import { parseCliArgs } from './argv.js';
import {
  HELP_TEXT,
  executeDoctorCommand,
  executeGenerateCommand,
  executeLifecycleCommand,
  executeNewCommand,
  executePluginCommand,
} from './commands.js';
import { CliError } from './errors.js';
import type { CliExecutionContext, CliResult } from './types.js';

const CLI_VERSION = '1.0.0-rc.2';

export async function runCli(
  argv: readonly string[],
  ctx: CliExecutionContext = {},
): Promise<CliResult> {
  const parsed = parseCliArgs(argv);

  try {
    switch (parsed.command) {
      case 'help': {
        const stdout = `${HELP_TEXT}\n`;
        ctx.stdout?.(stdout);
        return { exitCode: 0, command: 'help', stdout, stderr: '' };
      }
      case 'version': {
        const version = ctx.packageVersion ?? CLI_VERSION;
        const stdout = `${version}\n`;
        ctx.stdout?.(stdout);
        return { exitCode: 0, command: 'version', stdout, stderr: '', data: { version } };
      }
      case 'new':
        return await executeNewCommand(parsed, ctx);
      case 'g':
      case 'generate':
        return await executeGenerateCommand(parsed, ctx);
      case 'plugin':
        return await executePluginCommand(parsed, ctx);
      case 'doctor':
        return await executeDoctorCommand(parsed, ctx);
      case 'build':
      case 'dev':
      case 'start':
      case 'test':
        return await executeLifecycleCommand(parsed.command, parsed, ctx);
      default:
        throw new CliError(
          'CLI_INVALID_ARGUMENT',
          `Unknown command "${parsed.command}". Run "forge help" to list available commands.`,
        );
    }
  } catch (err: unknown) {
    const message = isForgeError(err)
      ? `[${err.code}] ${err.message}`
      : err instanceof Error
        ? err.message
        : String(err);
    const stderr = `${message}\n`;
    ctx.stderr?.(stderr);
    return {
      exitCode: 1,
      command: parsed.command,
      stdout: '',
      stderr,
    };
  }
}
