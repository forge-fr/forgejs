import type { ParsedCliArgs } from './types.js';

const BOOLEAN_FLAGS = new Set([
  'help',
  'h',
  'version',
  'v',
  'yes',
  'y',
  'force',
  'f',
  'watch',
  'w',
  'json',
  'dry-run',
  'interactive',
  'i',
  'crud',
  'no-crud',
  'single',
  'only-module',
  'register',
  'no-pluralize',
]);

export function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  const positionals: string[] = [];
  const flags = new Set<string>();
  const options: Record<string, string> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;

    if (token === '--') {
      for (let j = i + 1; j < argv.length; j += 1) {
        positionals.push(argv[j]!);
      }
      break;
    }

    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eqIdx = body.indexOf('=');
      if (eqIdx >= 0) {
        const key = body.slice(0, eqIdx);
        const val = body.slice(eqIdx + 1);
        if (key) {
          options[key] = val;
        }
        continue;
      }

      if (BOOLEAN_FLAGS.has(body)) {
        flags.add(body);
        continue;
      }

      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        options[body] = next;
        i += 1;
      } else {
        flags.add(body);
      }
      continue;
    }

    if (token.startsWith('-') && token.length === 2) {
      const short = token.slice(1);
      if (short === 'h') flags.add('help');
      else if (short === 'v') flags.add('version');
      else if (short === 'y') flags.add('yes');
      else if (short === 'f') flags.add('force');
      else if (short === 'w') flags.add('watch');
      else if (short === 'i') flags.add('interactive');
      else flags.add(short);
      continue;
    }

    positionals.push(token);
  }

  const [firstPositional, ...restPositionals] = positionals;
  if (flags.has('help')) {
    return {
      command: 'help',
      positionals: firstPositional ? [firstPositional, ...restPositionals] : [],
      flags,
      options,
    };
  }
  if (flags.has('version') && !firstPositional) {
    return {
      command: 'version',
      positionals: [],
      flags,
      options,
    };
  }

  return {
    command: firstPositional ?? 'help',
    positionals: restPositionals,
    flags,
    options,
  };
}
