import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const ROOT = process.cwd();
const CANONICAL_SCOPE = '@forge-fr';
const EXPECTED_VERSION = '1.0.0';
const EXPECTED_REPO_URL = 'https://github.com/forge-fr/forgejs.git';

const PACKAGES = [
  'core',
  'config',
  'router',
  'http',
  'testing',
  'node',
  'bun',
  'edge',
  'validation',
  'database',
  'drizzle',
  'prisma',
  'auth',
  'authorization',
  'security',
  'logger',
  'cache',
  'queue',
  'storage',
  'openapi',
  'cli',
];

const FORBIDDEN_PATH_PATTERNS = [
  /^src\//,
  /^tests\//,
  /\.test\./,
  /\.spec\./,
  /^\.env/,
  /^tsconfig/,
  /^node_modules\//,
  /^\//,
];

/**
 * Resolves the exact transitive closure of external npm packages declared by
 * the packed tarballs (plus explicit consumer smoke test packages like `zod`
 * and `@types/node` for TypeScript checking) and symlinks ONLY those packages
 * into the clean consumer `node_modules`.
 *
 * This guarantees that undeclared runtime dependencies (e.g. root workspace
 * packages like `react`, `express`, or `vite`) cannot silently leak into
 * verification.
 */
async function linkDeclaredExternalDeps(consumerNodeModules, seedPackages) {
  const rootNodeModules = path.join(ROOT, 'node_modules');
  const visited = new Set();
  const queue = [...seedPackages];

  async function resolvePackageDir(pkgName) {
    const candidate = path.join(rootNodeModules, ...pkgName.split('/'));
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      return null;
    }
  }

  while (queue.length > 0) {
    const pkgName = queue.shift();
    if (!pkgName || visited.has(pkgName) || pkgName.startsWith(`${CANONICAL_SCOPE}/`)) {
      continue;
    }

    const pkgDir = await resolvePackageDir(pkgName);
    if (!pkgDir) {
      continue;
    }

    visited.add(pkgName);

    const destPath = path.join(consumerNodeModules, ...pkgName.split('/'));
    if (pkgName.includes('/')) {
      await fs.mkdir(path.dirname(destPath), { recursive: true });
    }
    try {
      await fs.lstat(destPath);
    } catch {
      await fs.symlink(pkgDir, destPath, 'dir');
    }

    // Walk declared runtime/optional/peer dependencies of this external package
    try {
      const raw = await fs.readFile(path.join(pkgDir, 'package.json'), 'utf8');
      const manifest = JSON.parse(raw);
      for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
        const deps = manifest[field];
        if (!deps || typeof deps !== 'object') continue;
        for (const depName of Object.keys(deps)) {
          if (!visited.has(depName)) {
            queue.push(depName);
          }
        }
      }
    } catch {
      // Some helper directories might not contain a readable package.json
    }
  }

  // Verify isolation: unrelated root workspace dependencies must NOT be linked
  for (const forbiddenLeak of ['react', 'express', 'vite', '@google/genai']) {
    let leaked = false;
    try {
      await fs.lstat(path.join(consumerNodeModules, ...forbiddenLeak.split('/')));
      leaked = true;
    } catch {
      leaked = false;
    }
    assert.equal(
      leaked,
      false,
      `Clean consumer node_modules unexpectedly received undeclared root package "${forbiddenLeak}"`,
    );
  }

  return visited.size;
}

function buildConsumerTypecheckSource() {
  return `
import { createKernel, createToken, defineModule, FORGE_CORE_VERSION } from '@forge-fr/core';
import { defineConfig, createConfigPlugin, parseDotEnv } from '@forge-fr/config';
import { loadDotEnvFiles } from '@forge-fr/config/node';
import { createRouter } from '@forge-fr/router';
import { createHttpApp, createContextKey, createCompressionMiddleware, createEtagMiddleware } from '@forge-fr/http';
import { createTestClient, createTestApp, createTestKernel, overrideValue, createPluginTestHarness } from '@forge-fr/testing';
import { createNodeAdapter, attachProcessShutdown as attachNodeShutdown } from '@forge-fr/node';
import { createBunAdapter, attachProcessShutdown as attachBunShutdown } from '@forge-fr/bun';
import { createEdgeHandler, createCloudflareWorkerHandler, createDenoHandler } from '@forge-fr/edge';
import { validatedHandler, validateOrThrow } from '@forge-fr/validation';
import { createDatabasePlugin, createPostgresAdapter } from '@forge-fr/database';
import { createDrizzleAdapter } from '@forge-fr/drizzle';
import { createPrismaAdapter } from '@forge-fr/prisma';
import { AuthIdentityKey, createJwtService, createArgon2PasswordHasher, createAuthPlugin } from '@forge-fr/auth';
import { createAuthorizer, createAuthorizationPlugin } from '@forge-fr/authorization';
import { createSecurityHeadersMiddleware, createSafeFetch, createSecurityPlugin } from '@forge-fr/security';
import { CorrelationIdKey, RequestLoggerKey, createMemoryLogSink, createObservabilityPlugin } from '@forge-fr/logger';
import { createEdgeLogger } from '@forge-fr/logger/edge';
import { createMemoryCacheAdapter, createCachePlugin } from '@forge-fr/cache';
import { createMemoryQueueAdapter, createQueuePlugin } from '@forge-fr/queue';
import { createMemoryStorageAdapter, createStoragePlugin } from '@forge-fr/storage';
import { generateOpenApiDocument, createOpenApiPlugin } from '@forge-fr/openapi';
import { runCli } from '@forge-fr/cli';
import { z } from 'zod';

export const verifiedSymbols = {
  FORGE_CORE_VERSION,
  createKernel,
  createToken,
  defineModule,
  defineConfig,
  createConfigPlugin,
  parseDotEnv,
  loadDotEnvFiles,
  createRouter,
  createHttpApp,
  createContextKey,
  createCompressionMiddleware,
  createEtagMiddleware,
  createTestClient,
  createTestApp,
  createTestKernel,
  overrideValue,
  createPluginTestHarness,
  createNodeAdapter,
  attachNodeShutdown,
  createBunAdapter,
  attachBunShutdown,
  createEdgeHandler,
  createCloudflareWorkerHandler,
  createDenoHandler,
  validatedHandler,
  validateOrThrow,
  createDatabasePlugin,
  createPostgresAdapter,
  createDrizzleAdapter,
  createPrismaAdapter,
  AuthIdentityKey,
  createJwtService,
  createArgon2PasswordHasher,
  createAuthPlugin,
  createAuthorizer,
  createAuthorizationPlugin,
  createSecurityHeadersMiddleware,
  createSafeFetch,
  createSecurityPlugin,
  CorrelationIdKey,
  RequestLoggerKey,
  createMemoryLogSink,
  createObservabilityPlugin,
  createEdgeLogger,
  createMemoryCacheAdapter,
  createCachePlugin,
  createMemoryQueueAdapter,
  createQueuePlugin,
  createMemoryStorageAdapter,
  createStoragePlugin,
  generateOpenApiDocument,
  createOpenApiPlugin,
  runCli,
  schema: z.object({ ok: z.boolean() }),
};
`;
}

function buildConsumerRuntimeSmokeSource() {
  return `
import assert from 'node:assert/strict';
import { createKernel, createToken, defineModule, FORGE_CORE_VERSION } from '@forge-fr/core';
import { defineConfig } from '@forge-fr/config';
import { loadDotEnvFiles } from '@forge-fr/config/node';
import { createRouter } from '@forge-fr/router';
import { createHttpApp, createContextKey, createEtagMiddleware } from '@forge-fr/http';
import { createTestClient } from '@forge-fr/testing';
import { createNodeAdapter } from '@forge-fr/node';
import { createBunAdapter } from '@forge-fr/bun';
import { createEdgeHandler } from '@forge-fr/edge';
import { validatedHandler } from '@forge-fr/validation';
import { createMigrationCoordinator } from '@forge-fr/database';
import { createDrizzleToken } from '@forge-fr/drizzle';
import { createPrismaToken } from '@forge-fr/prisma';
import { AuthIdentityKey, createAuthPlugin } from '@forge-fr/auth';
import { createAuthorizer, createAuthorizationPlugin } from '@forge-fr/authorization';
import { createSecurityHeadersMiddleware, createSecurityPlugin } from '@forge-fr/security';
import { CorrelationIdKey, createMemoryLogSink, createObservabilityPlugin } from '@forge-fr/logger';
import { createEdgeLogger, createEdgeMemoryLogSink } from '@forge-fr/logger/edge';
import { createMemoryCacheAdapter, createCachePlugin } from '@forge-fr/cache';
import { createMemoryQueueAdapter, createQueuePlugin } from '@forge-fr/queue';
import { createMemoryStorageAdapter, createStoragePlugin } from '@forge-fr/storage';
import { generateOpenApiDocument, createOpenApiPlugin } from '@forge-fr/openapi';
import { runCli } from '@forge-fr/cli';
import { z } from 'zod';

assert.equal(FORGE_CORE_VERSION, '${EXPECTED_VERSION}');

// 0. Typed Config + Edge Logger subpaths
const cfg = defineConfig({
  schema: z.object({ PORT: z.coerce.number().int().default(3000) }),
  env: { PORT: '4040' },
});
assert.equal(cfg.PORT, 4040);
assert.equal(typeof loadDotEnvFiles, 'function');
const edgeSink = createEdgeMemoryLogSink();
const edgeLog = createEdgeLogger({ writer: edgeSink.writer });
edgeLog.info('edge-ready');
assert.equal(edgeSink.entries().length, 1);
assert.ok(AuthIdentityKey.id);
assert.ok(CorrelationIdKey.id);
const TraceKey = createContextKey('smoke.trace');
assert.ok(TraceKey.id);

// 1. Router
const router = createRouter();
router.get('/items/:id', () => 'ok');
const routeMatch = router.match('GET', '/items/42');
assert.equal(routeMatch.kind, 'found');
assert.equal(routeMatch.params['id'], '42');

// 2. Kernel + all official DI plugins
const GreetingToken = createToken('greeting');
const AppMod = defineModule({
  name: 'smoke-app',
  providers: [{ token: GreetingToken, useValue: 'hello-rc2' }],
  exports: [GreetingToken],
});

const cache = createMemoryCacheAdapter();
const queue = createMemoryQueueAdapter();
const storage = createMemoryStorageAdapter();
const sink = createMemoryLogSink();
const app = createHttpApp();
app.use(createSecurityHeadersMiddleware());
app.use(createEtagMiddleware());
app.post(
  '/echo',
  validatedHandler(
    { body: z.object({ name: z.string().min(2) }) },
    (ctx, input) => ctx.json({ greeted: input.body.name }),
  ),
);

const kernel = createKernel({
  modules: [AppMod],
  plugins: [
    createAuthPlugin(),
    createAuthorizationPlugin(),
    createSecurityPlugin(),
    createObservabilityPlugin({ serviceName: 'smoke', logger: { destination: sink.stream } }),
    createCachePlugin({ adapter: cache }),
    createQueuePlugin({ queue }),
    createStoragePlugin({ adapter: storage }),
    createOpenApiPlugin({ app, title: 'Smoke API', version: '${EXPECTED_VERSION}' }),
  ],
});

await kernel.start();
assert.equal(kernel.container.resolve(GreetingToken), 'hello-rc2');
const health = await kernel.health.runAll();
assert.equal(health.status, 'ok');

// 3. HTTP + Validation + OpenAPI + Edge + TestClient
const client = createTestClient(app);
const res = await client.post('/echo', { json: { name: 'ForgeJS' } });
assert.equal(res.status, 200);
assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
assert.deepEqual(await res.json(), { greeted: 'ForgeJS' });

const edgeHandler = createEdgeHandler(app);
const edgeRes = await edgeHandler(new Request('http://localhost/openapi.json'));
assert.equal(edgeRes.status, 200);
const spec = generateOpenApiDocument(app, { title: 'Smoke API', version: '${EXPECTED_VERSION}' });
assert.equal(spec.openapi, '3.1.0');
await client.close();

// 4. Adapters & Tokens
assert.equal(typeof createNodeAdapter, 'function');
assert.equal(typeof createBunAdapter, 'function');
assert.ok(createDrizzleToken('db'));
assert.ok(createPrismaToken('prisma'));
assert.ok(createMigrationCoordinator({ migrations: [] }));
assert.ok(createAuthorizer());

// 5. CLI
const cliRes = await runCli(['version']);
assert.equal(cliRes.exitCode, 0);
assert.equal(cliRes.stdout.trim(), '${EXPECTED_VERSION}');

await kernel.dispose();

// 6. Verify subpath encapsulation blocks internal dist files
let blockedInternal = false;
try {
  await import('@forge-fr/core/dist/di.js');
} catch {
  blockedInternal = true;
}
assert.equal(blockedInternal, true, 'Internal @forge-fr/core/dist/di.js import must be blocked by package exports');

console.log(JSON.stringify({ ok: true, runtime: 'Bun' in globalThis ? 'bun' : 'node', version: FORGE_CORE_VERSION, packagesVerified: 21 }));
`;
}

function buildCjsRequireEsmSmokeSource() {
  return `
const assert = require('node:assert/strict');
const core = require('@forge-fr/core');
const routerMod = require('@forge-fr/router');
const httpMod = require('@forge-fr/http');
const validationMod = require('@forge-fr/validation');

assert.equal(core.FORGE_CORE_VERSION, '${EXPECTED_VERSION}');
assert.equal(typeof core.createKernel, 'function');
assert.equal(typeof routerMod.createRouter, 'function');
assert.equal(typeof httpMod.createHttpApp, 'function');
assert.equal(typeof validationMod.validatedHandler, 'function');

const router = routerMod.createRouter();
router.get('/cjs/:id', () => 'ok');
const match = router.match('GET', '/cjs/7');
assert.equal(match.kind, 'found');
assert.equal(match.params.id, '7');

console.log(JSON.stringify({ ok: true, mode: 'require(esm)', version: core.FORGE_CORE_VERSION }));
`;
}

function supportsRequireEsm() {
  const [majorStr, minorStr] = process.versions.node.split('.');
  const major = Number(majorStr ?? 0);
  const minor = Number(minorStr ?? 0);
  return major > 22 || (major === 22 && minor >= 12);
}

export async function runPackagingVerification() {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forgejs-pack-verify-'));
  const tarballsDir = path.join(workDir, 'tarballs');
  const consumerDir = path.join(workDir, 'consumer');
  const consumerNodeModules = path.join(consumerDir, 'node_modules');
  const consumerScopeDir = path.join(consumerNodeModules, CANONICAL_SCOPE);

  await fs.mkdir(tarballsDir, { recursive: true });
  await fs.mkdir(consumerScopeDir, { recursive: true });

  const packageReports = [];
  const declaredExternalSeed = new Set(['zod', '@types/node']);

  try {
    // 1. Pack all 20 packages and audit tarball metadata & hygiene
    for (const pkg of PACKAGES) {
      const pkgDir = path.join(ROOT, 'packages', pkg);
      const manifest = JSON.parse(await fs.readFile(path.join(pkgDir, 'package.json'), 'utf8'));

      assert.equal(manifest.name, `${CANONICAL_SCOPE}/${pkg}`, `${pkg}: unexpected package name`);
      assert.equal(manifest.version, EXPECTED_VERSION, `${pkg}: expected version ${EXPECTED_VERSION}`);
      assert.equal(manifest.type, 'module', `${pkg}: expected pure ESM "type": "module"`);
      assert.equal(manifest.license, 'MIT', `${pkg}: expected MIT license`);
      assert.equal(manifest.publishConfig?.access, 'public', `${pkg}: expected publishConfig.access=public`);
      assert.equal(manifest.publishConfig?.provenance, true, `${pkg}: expected publishConfig.provenance=true`);
      assert.equal(
        manifest.repository?.url,
        EXPECTED_REPO_URL,
        `${pkg}: expected normalized repository URL`,
      );
      assert.equal(
        JSON.stringify(manifest).includes('<ORG>'),
        false,
        `${pkg}: contains forbidden <ORG> placeholder`,
      );

      for (const depField of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
        const deps = manifest[depField];
        if (!deps || typeof deps !== 'object') continue;
        for (const depName of Object.keys(deps)) {
          if (!depName.startsWith(`${CANONICAL_SCOPE}/`)) {
            declaredExternalSeed.add(depName);
          }
        }
      }

      const { stdout } = await execFileAsync(
        'npm',
        ['pack', '--json', '--pack-destination', tarballsDir],
        { cwd: pkgDir },
      );

      const packInfoList = JSON.parse(stdout);
      assert.equal(packInfoList.length, 1, `${pkg}: expected 1 tarball entry`);
      const info = packInfoList[0];
      const filePaths = info.files.map((f) => f.path);

      for (const required of [
        'package.json',
        'README.md',
        'CHANGELOG.md',
        'LICENSE',
        'dist/index.js',
        'dist/index.d.ts',
      ]) {
        assert.ok(
          filePaths.includes(required),
          `${pkg}: tarball missing required file "${required}"`,
        );
      }

      if (pkg === 'cli') {
        assert.ok(filePaths.includes('dist/bin.js'), 'cli: tarball missing dist/bin.js');
      }

      for (const fp of filePaths) {
        for (const forbidden of FORBIDDEN_PATH_PATTERNS) {
          assert.equal(
            forbidden.test(fp),
            false,
            `${pkg}: tarball contains forbidden file "${fp}"`,
          );
        }
      }

      const tarballPath = path.join(tarballsDir, info.filename);
      const targetPkgDir = path.join(consumerScopeDir, pkg);
      await fs.mkdir(targetPkgDir, { recursive: true });
      await execFileAsync('tar', ['-xzf', tarballPath, '-C', targetPkgDir, '--strip-components=1']);

      if (pkg === 'cli') {
        const binContent = await fs.readFile(path.join(targetPkgDir, 'dist/bin.js'), 'utf8');
        assert.ok(
          binContent.startsWith('#!/usr/bin/env node'),
          'cli: dist/bin.js missing #!/usr/bin/env node shebang',
        );
      }

      packageReports.push({
        name: info.name,
        version: info.version,
        filename: info.filename,
        sizeBytes: info.size,
        unpackedSizeBytes: info.unpackedSize,
        entryCount: info.entryCount,
      });
    }

    // 2. Link ONLY declared external transitive runtime dependencies into clean consumer dir
    const externalDepsLinkedCount = await linkDeclaredExternalDeps(
      consumerNodeModules,
      declaredExternalSeed,
    );

    await fs.writeFile(
      path.join(consumerDir, 'package.json'),
      JSON.stringify(
        {
          name: 'forgejs-clean-consumer-smoke',
          private: true,
          type: 'module',
        },
        null,
        2,
      ),
      'utf8',
    );

    await fs.writeFile(path.join(consumerDir, 'types-smoke.ts'), buildConsumerTypecheckSource(), 'utf8');
    await fs.writeFile(path.join(consumerDir, 'runtime-smoke.mjs'), buildConsumerRuntimeSmokeSource(), 'utf8');
    await fs.writeFile(path.join(consumerDir, 'cjs-require-smoke.cjs'), buildCjsRequireEsmSmokeSource(), 'utf8');

    // 3. Verify strict TypeScript .d.ts resolution under NodeNext AND Bundler
    const tscBin = path.join(ROOT, 'node_modules', '.bin', 'tsc');

    await fs.writeFile(
      path.join(consumerDir, 'tsconfig.nodenext.json'),
      JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            strict: true,
            exactOptionalPropertyTypes: true,
            noUncheckedIndexedAccess: true,
            verbatimModuleSyntax: true,
            noEmit: true,
            skipLibCheck: true,
          },
          files: ['types-smoke.ts'],
        },
        null,
        2,
      ),
      'utf8',
    );

    await fs.writeFile(
      path.join(consumerDir, 'tsconfig.bundler.json'),
      JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
            strict: true,
            exactOptionalPropertyTypes: true,
            noUncheckedIndexedAccess: true,
            verbatimModuleSyntax: true,
            noEmit: true,
            skipLibCheck: true,
          },
          files: ['types-smoke.ts'],
        },
        null,
        2,
      ),
      'utf8',
    );

    await execFileAsync(tscBin, ['-p', path.join(consumerDir, 'tsconfig.nodenext.json')], {
      cwd: consumerDir,
    });
    await execFileAsync(tscBin, ['-p', path.join(consumerDir, 'tsconfig.bundler.json')], {
      cwd: consumerDir,
    });

    // 4. Execute clean external consumer runtime smoke test on Node.js (ESM)
    const nodeSmoke = await execFileAsync('node', [path.join(consumerDir, 'runtime-smoke.mjs')], {
      cwd: consumerDir,
    });
    const nodeResult = JSON.parse(nodeSmoke.stdout.trim());
    assert.equal(nodeResult.ok, true);
    assert.equal(nodeResult.runtime, 'node');
    assert.equal(nodeResult.packagesVerified, 21);

    // 5. Execute Node.js 22.12+ CJS require(esm) compatibility verification
    let cjsRequireSmoke = { skipped: true };
    if (supportsRequireEsm()) {
      const cjsSmoke = await execFileAsync('node', [path.join(consumerDir, 'cjs-require-smoke.cjs')], {
        cwd: consumerDir,
      });
      cjsRequireSmoke = JSON.parse(cjsSmoke.stdout.trim());
      assert.equal(cjsRequireSmoke.ok, true);
      assert.equal(cjsRequireSmoke.mode, 'require(esm)');
    }

    // 6. Execute unpacked @forge-fr/cli bin.js directly on Node.js
    const cliBinPath = path.join(consumerScopeDir, 'cli', 'dist', 'bin.js');
    const nodeCli = await execFileAsync('node', [cliBinPath, 'version'], { cwd: consumerDir });
    assert.equal(nodeCli.stdout.trim(), EXPECTED_VERSION);

    // 7. Execute clean external consumer runtime smoke test on Bun (if installed)
    let bunResult = null;
    try {
      const bunSmoke = await execFileAsync('bun', ['run', path.join(consumerDir, 'runtime-smoke.mjs')], {
        cwd: consumerDir,
      });
      bunResult = JSON.parse(bunSmoke.stdout.trim());
      assert.equal(bunResult.ok, true);
      assert.equal(bunResult.runtime, 'bun');
      assert.equal(bunResult.packagesVerified, 21);

      const bunCli = await execFileAsync('bun', [cliBinPath, 'version'], { cwd: consumerDir });
      assert.equal(bunCli.stdout.trim(), EXPECTED_VERSION);
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
        bunResult = { skipped: true };
      } else {
        throw err;
      }
    }

    return {
      ok: true,
      canonicalScope: CANONICAL_SCOPE,
      expectedVersion: EXPECTED_VERSION,
      packagesPacked: packageReports.length,
      externalDepsLinkedCount,
      typecheckModes: ['NodeNext', 'Bundler'],
      nodeSmoke: nodeResult,
      cjsRequireSmoke,
      bunSmoke: bunResult,
      packages: packageReports,
    };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

const isDirectEntry =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (isDirectEntry) {
  const report = await runPackagingVerification();
  console.log(JSON.stringify(report, null, 2));
}
