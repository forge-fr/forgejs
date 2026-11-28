import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CliError,
  generateArtifactFiles,
  parseCliArgs,
  resolveSafeTargetPath,
  runCli,
  validateProjectName,
  validateSymbolName,
} from '@forge-fr/cli';
import { afterEach, describe, expect, it } from 'vitest';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('@forge-fr/cli — Scaffolding, Generators, Plugin Registry, Diagnostics & Runner', () => {
  it('parses CLI commands, flags, aliases, and enforces strict project/symbol path confinement', async () => {
    const parsed = parseCliArgs([
      'new',
      'billing-api',
      '--template',
      'api',
      '--runtime',
      'bun',
      '--port=4100',
      '--yes',
    ]);
    expect(parsed.command).toBe('new');
    expect(parsed.positionals).toEqual(['billing-api']);
    expect(parsed.options['template']).toBe('api');
    expect(parsed.options['runtime']).toBe('bun');
    expect(parsed.options['port']).toBe('4100');
    expect(parsed.flags.has('yes')).toBe(true);

    expect(validateProjectName('billing-api')).toBe('billing-api');
    expect(() => validateProjectName('../escape')).toThrow(CliError);
    expect(() => validateProjectName('__proto__')).toThrow(CliError);
    expect(() => validateProjectName('bad;rm -rf /')).toThrow(CliError);

    expect(validateSymbolName('order-item')).toEqual({
      kebab: 'order-item',
      pascal: 'OrderItem',
      camel: 'orderItem',
    });
    expect(() => validateSymbolName('../../etc/passwd')).toThrow(CliError);

    const baseDir = await makeTempDir('forge-cli-safe-');
    expect(resolveSafeTargetPath(baseDir, 'src/modules/orders.ts')).toBe(
      path.join(path.resolve(baseDir), 'src/modules/orders.ts'),
    );
    expect(() => resolveSafeTargetPath(baseDir, '../outside.ts')).toThrow(CliError);
  });

  it('scaffolds pure-ESM ForgeJS projects (`new`), prevents accidental overwrite, and generates module/controller/service artifacts', async () => {
    const workspace = await makeTempDir('forge-cli-new-');

    const dryRunRes = await runCli(
      ['new', 'orders-app', '--template', 'api', '--dry-run'],
      { cwd: workspace },
    );
    expect(dryRunRes.exitCode).toBe(0);
    await expect(fs.stat(path.join(workspace, 'orders-app'))).rejects.toThrow();

    const createRes = await runCli(
      ['new', 'orders-app', '--template', 'api', '--runtime', 'node'],
      { cwd: workspace },
    );
    expect(createRes.exitCode).toBe(0);

    const projectDir = path.join(workspace, 'orders-app');
    const pkgJson = JSON.parse(
      await fs.readFile(path.join(projectDir, 'package.json'), 'utf8'),
    ) as { name: string; type: string; dependencies: Record<string, string> };
    expect(pkgJson.name).toBe('orders-app');
    expect(pkgJson.type).toBe('module');
    expect(pkgJson.dependencies['@forge-fr/core']).toBe('^1.0.0');
    expect(pkgJson.dependencies['@forge-fr/openapi']).toBe('^1.0.0');
    expect(pkgJson.dependencies['@forge-fr/node']).toBe('^1.0.0');

    const entrySource = await fs.readFile(path.join(projectDir, 'src/index.ts'), 'utf8');
    expect(entrySource).toContain('createHttpApp');
    const appSource = await fs.readFile(path.join(projectDir, 'src/app.ts'), 'utf8');
    expect(appSource).toContain('registerOpenApiRoutes');

    const duplicateRes = await runCli(['new', 'orders-app'], { cwd: workspace });
    expect(duplicateRes.exitCode).not.toBe(0);

    // Code generators inside created project
    const modRes = await runCli(['g', 'module', 'billing-ledger', '--single'], { cwd: projectDir });
    expect(modRes.exitCode).toBe(0);
    const ctrlRes = await runCli(['generate', 'controller', 'billing-ledger'], {
      cwd: projectDir,
    });
    expect(ctrlRes.exitCode).toBe(0);
    const svcRes = await runCli(['generate', 'service', 'billing-ledger'], {
      cwd: projectDir,
    });
    expect(svcRes.exitCode).toBe(0);

    const generatedService = await fs.readFile(
      path.join(projectDir, 'src/modules/billing-ledgers/billing-ledgers.service.ts'),
      'utf8',
    );
    expect(generatedService).toContain('BillingLedgersService');
    expect(generatedService).toContain('createToken');

    const bundle = generateArtifactFiles('module', 'audit-log');
    expect(bundle.relativePath).toBe('src/audit-log/audit-log.module.ts');
  });

  it('adds official ForgeJS plugins safely, inspects project health (`doctor`), and delegates build/dev/start/test without shell injection', async () => {
    const projectDir = await makeTempDir('forge-cli-plugin-');
    await fs.writeFile(
      path.join(projectDir, 'package.json'),
      JSON.stringify({ name: 'demo-app', type: 'module', dependencies: { '@forge-fr/core': '^1.0.0' } }, null, 2),
      'utf8',
    );
    await fs.writeFile(
      path.join(projectDir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict: true, module: 'NodeNext' } }, null, 2),
      'utf8',
    );

    const pluginRes = await runCli(['plugin', 'add', 'security'], { cwd: projectDir });
    expect(pluginRes.exitCode).toBe(0);

    const edgePluginRes = await runCli(['plugin', 'add', 'edge'], { cwd: projectDir });
    expect(edgePluginRes.exitCode).toBe(0);

    const updatedPkg = JSON.parse(
      await fs.readFile(path.join(projectDir, 'package.json'), 'utf8'),
    ) as { dependencies: Record<string, string> };
    expect(updatedPkg.dependencies['@forge-fr/security']).toBe('^1.0.0');
    expect(updatedPkg.dependencies['@forge-fr/edge']).toBe('^1.0.0');

    const edgeScaffold = await runCli(
      ['new', 'edge-worker', '--template', 'minimal', '--runtime', 'edge'],
      { cwd: projectDir },
    );
    expect(edgeScaffold.exitCode).toBe(0);
    const edgeEntry = await fs.readFile(path.join(projectDir, 'edge-worker/src/index.ts'), 'utf8');
    expect(edgeEntry).toContain('createCloudflareWorkerHandler');
    const edgePkg = JSON.parse(
      await fs.readFile(path.join(projectDir, 'edge-worker/package.json'), 'utf8'),
    ) as { dependencies: Record<string, string> };
    expect(edgePkg.dependencies['@forge-fr/edge']).toBe('^1.0.0');

    const invalidPluginRes = await runCli(['plugin', 'add', 'unknown;rm -rf /'], {
      cwd: projectDir,
    });
    expect(invalidPluginRes.exitCode).not.toBe(0);

    const doctorRes = await runCli(['doctor', '--json'], { cwd: projectDir });
    expect(doctorRes.exitCode).toBe(0);
    const report = JSON.parse(doctorRes.stdout) as {
      ok: boolean;
      runtime: { nodeVersion: string };
      checks: Array<{ id: string; status: string }>;
    };
    expect(report.ok).toBe(true);
    expect(report.checks.find((c) => c.id === 'esm-type-module')?.status).toBe('ok');
    expect(report.checks.find((c) => c.id === 'typescript-strict')?.status).toBe('ok');

    const recordedCalls: Array<{ command: string; args: readonly string[] }> = [];
    const mockSpawn = async (command: string, args: readonly string[]) => {
      recordedCalls.push({ command, args });
      return { exitCode: 0 };
    };

    const buildRes = await runCli(['build'], { cwd: projectDir, spawnCommand: mockSpawn });
    expect(buildRes.exitCode).toBe(0);
    expect(recordedCalls.some((c) => c.args.some((a) => a.includes('tsc')))).toBe(true);

    const testRes = await runCli(['test', '--runtime', 'bun'], {
      cwd: projectDir,
      spawnCommand: mockSpawn,
    });
    expect(testRes.exitCode).toBe(0);
    expect(recordedCalls.some((c) => c.command === 'bun' && c.args[0] === 'test')).toBe(true);
  });
});
