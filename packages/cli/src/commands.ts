import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CliError } from './errors.js';
import {
  resolvePluginPackageSpec,
  resolveSafeTargetPath,
  sanitizeJsonObject,
  validateProjectName,
} from './safety.js';
import { buildProjectTemplateFiles, generateArtifactFiles } from './templates.js';
import type {
  CliExecutionContext,
  CliResult,
  CliRuntimeTarget,
  CliSpawnFn,
  DoctorCheckResult,
  DoctorReport,
  GeneratorArtifactKind,
  ParsedCliArgs,
  ProjectRuntimeTarget,
  ProjectTemplateKind,
  SpawnCommandOptions,
  SpawnCommandResult,
} from './types.js';

export const HELP_TEXT = [
  'ForgeJS CLI (cross-runtime Node.js >=22.18 & Bun >=1.4)',
  '',
  'Usage:',
  '  forge <command> [arguments] [options]',
  '',
  'Commands:',
  '  new <name>                         Create a new ForgeJS project',
  '  generate <type> <name>             Generate module, controller, or service (alias: g)',
  '  plugin add <plugin>                Register a ForgeJS or npm plugin into package.json',
  '  dev                                Start development server (supports --watch, --runtime)',
  '  build                              Compile TypeScript project (tsc -b)',
  '  start                              Start compiled dist/index.js server',
  '  test                               Run project test suite',
  '  doctor                             Inspect Node/Bun runtimes, ESM & strict TypeScript config',
  '  help                               Show this help output',
  '  version                            Show CLI version',
].join('\n');

export function defaultSpawnCommand(
  command: string,
  args: readonly string[],
  options: SpawnCommandOptions,
): Promise<SpawnCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: 'pipe',
    });

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdoutChunks.push(chunk.toString());
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderrChunks.push(chunk.toString());
    });
    child.on('error', (err) => {
      reject(err);
    });
    child.on('close', (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout: stdoutChunks.join(''),
        stderr: stderrChunks.join(''),
      });
    });
  });
}

function getActiveRuntime(): 'node' | 'bun' {
  const g = globalThis as Record<string, unknown>;
  return typeof g['Bun'] === 'object' && g['Bun'] !== null ? 'bun' : 'node';
}

function resolveRuntimeTarget(raw?: string): 'node' | 'bun' {
  if (!raw || raw === 'auto') {
    return getActiveRuntime();
  }
  if (raw === 'node' || raw === 'bun') {
    return raw;
  }
  throw new CliError('CLI_INVALID_ARGUMENT', `Invalid --runtime value "${raw}". Use auto, node, or bun.`);
}

function resolveProjectRuntimeTarget(raw?: string): ProjectRuntimeTarget {
  if (!raw || raw === 'auto') {
    return getActiveRuntime();
  }
  if (raw === 'node' || raw === 'bun' || raw === 'edge') {
    return raw;
  }
  throw new CliError(
    'CLI_INVALID_ARGUMENT',
    `Invalid --runtime value "${raw}". Use auto, node, bun, or edge.`,
  );
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function executeNewCommand(
  parsed: ParsedCliArgs,
  ctx: CliExecutionContext,
): Promise<CliResult> {
  const rawName = parsed.positionals[0];
  if (!rawName) {
    throw new CliError('CLI_INVALID_ARGUMENT', 'Usage: forge new <project-name>');
  }

  const cwd = path.resolve(ctx.cwd ?? process.cwd());
  const projectName = validateProjectName(rawName);
  const template = (parsed.options['template'] ?? 'api') as ProjectTemplateKind;
  const runtimeOpt = parsed.options['runtime']
    ? resolveProjectRuntimeTarget(parsed.options['runtime'])
    : 'node';
  const rawPort = parsed.options['port'] ? Number(parsed.options['port']) : 3000;
  if (!Number.isInteger(rawPort) || rawPort <= 0 || rawPort > 65535) {
    throw new CliError('CLI_INVALID_ARGUMENT', `Invalid --port "${parsed.options['port']}"`);
  }

  const baseTarget = parsed.options['dir']
    ? path.resolve(cwd, parsed.options['dir'])
    : cwd;
  const projectDir = resolveSafeTargetPath(baseTarget, projectName);

  const files = buildProjectTemplateFiles({
    projectName,
    template,
    runtime: runtimeOpt,
    port: rawPort,
  });

  const dryRun = parsed.flags.has('dry-run');
  const force = parsed.flags.has('force');

  if (!dryRun) {
    if ((await pathExists(projectDir)) && !force) {
      throw new CliError(
        'CLI_FILE_EXISTS',
        `Directory "${projectDir}" already exists. Pass --force to overwrite.`,
      );
    }

    for (const file of files) {
      const targetFile = resolveSafeTargetPath(projectDir, file.relativePath);
      await fs.mkdir(path.dirname(targetFile), { recursive: true });
      await fs.writeFile(targetFile, file.content, 'utf8');
    }
  }

  const lines = [
    `${dryRun ? '[dry-run] Planned' : 'Created'} ForgeJS project "${projectName}" at ${projectDir}`,
    `  template: ${template}`,
    `  runtime:  ${runtimeOpt}`,
    `  files:    ${files.length}`,
  ];
  const stdout = `${lines.join('\n')}\n`;
  ctx.stdout?.(stdout);

  return {
    exitCode: 0,
    command: 'new',
    stdout,
    stderr: '',
    data: { projectDir, files: files.map((f) => f.relativePath) },
  };
}

export async function executeGenerateCommand(
  parsed: ParsedCliArgs,
  ctx: CliExecutionContext,
): Promise<CliResult> {
  const kindRaw = parsed.positionals[0];
  const nameRaw = parsed.positionals[1];
  if (!kindRaw || !nameRaw) {
    throw new CliError(
      'CLI_INVALID_ARGUMENT',
      'Usage: forge generate <module|controller|service> <name>',
    );
  }
  if (!['module', 'controller', 'service'].includes(kindRaw)) {
    throw new CliError(
      'CLI_INVALID_ARGUMENT',
      `Unknown generator type "${kindRaw}". Expected module, controller, or service.`,
    );
  }

  const baseDir = path.resolve(ctx.cwd ?? process.cwd(), parsed.options['dir'] ?? '.');
  const artifact = generateArtifactFiles(kindRaw as GeneratorArtifactKind, nameRaw);
  const targetFile = resolveSafeTargetPath(baseDir, artifact.relativePath);

  const dryRun = parsed.flags.has('dry-run');
  const force = parsed.flags.has('force');
  if (!dryRun) {
    if ((await pathExists(targetFile)) && !force) {
      throw new CliError(
        'CLI_FILE_EXISTS',
        `File "${artifact.relativePath}" already exists. Pass --force to overwrite.`,
      );
    }
    await fs.mkdir(path.dirname(targetFile), { recursive: true });
    await fs.writeFile(targetFile, artifact.content, 'utf8');
  }

  const stdout = `${dryRun ? '[dry-run] Would generate' : 'Generated'} ${artifact.relativePath}\n`;
  ctx.stdout?.(stdout);
  return {
    exitCode: 0,
    command: 'generate',
    stdout,
    stderr: '',
    data: { relativePath: artifact.relativePath, targetFile },
  };
}

export async function executePluginCommand(
  parsed: ParsedCliArgs,
  ctx: CliExecutionContext,
): Promise<CliResult> {
  const sub = parsed.positionals[0];
  const pluginArg = parsed.positionals[1];
  if (sub !== 'add' || !pluginArg) {
    throw new CliError('CLI_INVALID_ARGUMENT', 'Usage: forge plugin add <plugin-name>');
  }

  const spec = resolvePluginPackageSpec(pluginArg);
  const projectDir = path.resolve(ctx.cwd ?? process.cwd(), parsed.options['dir'] ?? '.');
  const pkgPath = resolveSafeTargetPath(projectDir, 'package.json');

  let rawPkgText: string;
  try {
    rawPkgText = await fs.readFile(pkgPath, 'utf8');
  } catch (err) {
    throw new CliError('CLI_EXECUTION_FAILED', `Could not read package.json in ${projectDir}`, {
      cause: err,
    });
  }

  const rawPkg = JSON.parse(rawPkgText) as Record<string, unknown>;
  const safePkg = sanitizeJsonObject(rawPkg);
  const currentDeps =
    typeof safePkg['dependencies'] === 'object' && safePkg['dependencies'] !== null
      ? sanitizeJsonObject(safePkg['dependencies'] as Record<string, unknown>)
      : {};

  currentDeps[spec.packageName] = spec.versionRange;
  const sortedDeps: Record<string, unknown> = {};
  for (const key of Object.keys(currentDeps).sort()) {
    sortedDeps[key] = currentDeps[key];
  }
  safePkg['dependencies'] = sortedDeps;

  if (!parsed.flags.has('dry-run')) {
    await fs.writeFile(pkgPath, `${JSON.stringify(safePkg, null, 2)}\n`, 'utf8');
  }

  const stdout = `Registered plugin ${spec.packageName}@${spec.versionRange} in ${pkgPath}\n`;
  ctx.stdout?.(stdout);
  return {
    exitCode: 0,
    command: 'plugin',
    stdout,
    stderr: '',
    data: spec,
  };
}

export async function executeDoctorCommand(
  parsed: ParsedCliArgs,
  ctx: CliExecutionContext,
): Promise<CliResult> {
  const cwd = path.resolve(ctx.cwd ?? process.cwd(), parsed.options['dir'] ?? '.');
  const probe = ctx.probeCommand ?? ctx.spawnCommand ?? defaultSpawnCommand;
  const checks: DoctorCheckResult[] = [];

  const nodeVersion = process.version;
  const major = Number(nodeVersion.replace(/^v/, '').split('.')[0] ?? '0');
  checks.push({
    id: 'node-version',
    label: 'Node.js runtime version (>=22)',
    status: major >= 22 ? 'ok' : 'fail',
    message: `Detected ${nodeVersion}`,
  });

  let bunVersion: string | null = null;
  try {
    const bunRes = await probe('bun', ['--version'], { cwd });
    if (bunRes.exitCode === 0 && bunRes.stdout) {
      bunVersion = bunRes.stdout.trim();
      checks.push({
        id: 'bun-runtime',
        label: 'Bun runtime availability',
        status: 'ok',
        message: `Detected Bun ${bunVersion}`,
      });
    } else {
      checks.push({
        id: 'bun-runtime',
        label: 'Bun runtime availability',
        status: 'warn',
        message: 'Bun CLI not installed or returned non-zero status',
      });
    }
  } catch {
    checks.push({
      id: 'bun-runtime',
      label: 'Bun runtime availability',
      status: 'warn',
      message: 'Bun CLI unavailable on PATH',
    });
  }

  const pkgPath = path.join(cwd, 'package.json');
  if (await pathExists(pkgPath)) {
    const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8')) as { type?: string };
    checks.push({
      id: 'esm-type-module',
      label: 'ESM package boundary ("type": "module")',
      status: pkg.type === 'module' ? 'ok' : 'warn',
      message: pkg.type === 'module' ? 'package.json declares "type": "module"' : 'Missing "type": "module"',
    });
  } else {
    checks.push({
      id: 'esm-type-module',
      label: 'ESM package boundary ("type": "module")',
      status: 'warn',
      message: 'No package.json found in target directory',
    });
  }

  const tsconfigPath = path.join(cwd, 'tsconfig.json');
  if (await pathExists(tsconfigPath)) {
    const tsconfig = JSON.parse(await fs.readFile(tsconfigPath, 'utf8')) as {
      compilerOptions?: { strict?: boolean };
    };
    checks.push({
      id: 'typescript-strict',
      label: 'TypeScript strict mode',
      status: tsconfig.compilerOptions?.strict === true ? 'ok' : 'warn',
      message:
        tsconfig.compilerOptions?.strict === true
          ? 'strict: true enabled'
          : 'Enable compilerOptions.strict for ForgeJS safety',
    });
  }

  const ok = checks.every((c) => c.status !== 'fail');
  const report: DoctorReport = {
    ok,
    cwd,
    runtime: {
      activeRuntime: getActiveRuntime(),
      nodeVersion,
      bunVersion,
    },
    checks,
  };

  const stdout = parsed.flags.has('json')
    ? `${JSON.stringify(report, null, 2)}\n`
    : `${checks.map((c) => `[${c.status.toUpperCase()}] ${c.label}: ${c.message}`).join('\n')}\n`;
  ctx.stdout?.(stdout);

  return {
    exitCode: ok ? 0 : 1,
    command: 'doctor',
    stdout,
    stderr: '',
    data: report,
  };
}

export async function executeLifecycleCommand(
  command: 'build' | 'dev' | 'start' | 'test',
  parsed: ParsedCliArgs,
  ctx: CliExecutionContext,
): Promise<CliResult> {
  const cwd = path.resolve(ctx.cwd ?? process.cwd(), parsed.options['dir'] ?? '.');
  const runtimeTarget: CliRuntimeTarget = (parsed.options['runtime'] ?? 'auto') as CliRuntimeTarget;
  const resolvedRuntime = resolveRuntimeTarget(runtimeTarget);
  const runner: CliSpawnFn = ctx.spawnCommand ?? defaultSpawnCommand;

  let cmdBin: string;
  let cmdArgs: string[];

  if (command === 'build') {
    const localTsc = path.join(cwd, 'node_modules', '.bin', 'tsc');
    if (await pathExists(localTsc)) {
      cmdBin = localTsc;
      cmdArgs = ['-b', 'tsconfig.json'];
    } else if (resolvedRuntime === 'bun') {
      cmdBin = 'bunx';
      cmdArgs = ['tsc', '-b', 'tsconfig.json'];
    } else {
      cmdBin = 'npx';
      cmdArgs = ['tsc', '-b', 'tsconfig.json'];
    }
  } else if (command === 'start') {
    cmdBin = resolvedRuntime;
    cmdArgs = ['dist/index.js'];
  } else if (command === 'dev') {
    if (resolvedRuntime === 'bun') {
      cmdBin = 'bun';
      cmdArgs = parsed.flags.has('watch') ? ['--watch', 'src/index.ts'] : ['src/index.ts'];
    } else {
      const localTsx = path.join(cwd, 'node_modules', '.bin', 'tsx');
      cmdBin = (await pathExists(localTsx)) ? localTsx : 'npx';
      cmdArgs =
        cmdBin === 'npx'
          ? parsed.flags.has('watch')
            ? ['tsx', 'watch', 'src/index.ts']
            : ['tsx', 'src/index.ts']
          : parsed.flags.has('watch')
            ? ['watch', 'src/index.ts']
            : ['src/index.ts'];
    }
  } else {
    if (resolvedRuntime === 'bun') {
      cmdBin = 'bun';
      cmdArgs = ['test'];
    } else {
      const localVitest = path.join(cwd, 'node_modules', '.bin', 'vitest');
      if (await pathExists(localVitest)) {
        cmdBin = localVitest;
        cmdArgs = ['run'];
      } else {
        cmdBin = 'node';
        cmdArgs = ['--test'];
      }
    }
  }

  const res = await runner(cmdBin, cmdArgs, { cwd });
  const stdout = res.stdout ?? '';
  const stderr = res.stderr ?? '';
  if (stdout) ctx.stdout?.(stdout);
  if (stderr) ctx.stderr?.(stderr);

  return {
    exitCode: res.exitCode,
    command,
    stdout,
    stderr,
    data: { cmdBin, cmdArgs, runtime: resolvedRuntime },
  };
}
