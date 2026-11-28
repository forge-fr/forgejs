import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TOPOLOGICAL_PUBLISH_ORDER } from './prepare-github-packages.mjs';

export const CANONICAL_SCOPE = '@forge-fr';
export const CANONICAL_REPO_URL = 'https://github.com/forge-fr/forgejs.git';
export const CANONICAL_HOMEPAGE = 'https://github.com/forge-fr/forgejs#readme';
export const CANONICAL_BUGS_URL = 'https://github.com/forge-fr/forgejs/issues';

/**
 * Validates workspace package manifests, version consistency, export targets,
 * internal dependency ranges, topological ordering, and release hygiene.
 */
export async function verifyWorkspace(rootDir = process.cwd()) {
  const packagesRoot = path.join(rootDir, 'packages');
  const discoveredDirs = (await fs.readdir(packagesRoot, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  assert.deepEqual(
    [...TOPOLOGICAL_PUBLISH_ORDER].sort(),
    discoveredDirs,
    `TOPOLOGICAL_PUBLISH_ORDER must match packages/* directories exactly`,
  );

  // Read canonical version from packages/core/package.json
  const coreManifest = JSON.parse(
    await fs.readFile(path.join(packagesRoot, 'core', 'package.json'), 'utf8'),
  );
  const expectedVersion = coreManifest.version;
  assert.ok(
    typeof expectedVersion === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(expectedVersion),
    `Invalid canonical version "${expectedVersion}" in packages/core/package.json`,
  );

  // Verify FORGE_CORE_VERSION in packages/core/src/plugins.ts
  const pluginsSrc = await fs.readFile(path.join(packagesRoot, 'core', 'src', 'plugins.ts'), 'utf8');
  assert.ok(
    pluginsSrc.includes(`FORGE_CORE_VERSION = '${expectedVersion}'`),
    `packages/core/src/plugins.ts FORGE_CORE_VERSION must equal "${expectedVersion}"`,
  );

  // Verify CLI template & plugin resolver version parity
  const cliTemplates = await fs.readFile(path.join(packagesRoot, 'cli', 'src', 'templates.ts'), 'utf8');
  assert.ok(
    cliTemplates.includes(`const FORGE_SCOPE = '${CANONICAL_SCOPE}'`),
    `packages/cli/src/templates.ts FORGE_SCOPE must equal "${CANONICAL_SCOPE}"`,
  );
  assert.ok(
    cliTemplates.includes(`'^${expectedVersion}'`),
    `packages/cli/src/templates.ts must reference ^${expectedVersion}`,
  );

  const cliSafety = await fs.readFile(path.join(packagesRoot, 'cli', 'src', 'safety.ts'), 'utf8');
  assert.ok(
    cliSafety.includes(`versionRange: '^${expectedVersion}'`),
    `packages/cli/src/safety.ts official plugin versionRange must equal "^${expectedVersion}"`,
  );

  // Verify tsconfig.base.json paths alignment
  const tsconfigBase = JSON.parse(await fs.readFile(path.join(rootDir, 'tsconfig.base.json'), 'utf8'));
  assert.deepEqual(
    tsconfigBase?.compilerOptions?.paths?.[`${CANONICAL_SCOPE}/*`],
    ['./packages/*/dist/index.d.ts'],
    `tsconfig.base.json paths must map "${CANONICAL_SCOPE}/*" to "./packages/*/dist/index.d.ts"`,
  );

  const seenNames = new Set();
  const packageSummaries = [];

  for (const dir of TOPOLOGICAL_PUBLISH_ORDER) {
    const pkgDir = path.join(packagesRoot, dir);
    const manifestPath = path.join(pkgDir, 'package.json');
    const rawManifest = await fs.readFile(manifestPath, 'utf8');
    assert.equal(rawManifest.includes('<ORG>'), false, `${dir}: contains forbidden <ORG> placeholder`);

    const manifest = JSON.parse(rawManifest);
    const expectedName = `${CANONICAL_SCOPE}/${dir}`;

    assert.equal(manifest.name, expectedName, `${dir}: expected package name "${expectedName}"`);
    assert.equal(manifest.version, expectedVersion, `${dir}: expected version "${expectedVersion}"`);
    assert.equal(manifest.type, 'module', `${dir}: expected pure ESM "type": "module"`);
    assert.equal(manifest.license, 'MIT', `${dir}: expected MIT license`);
    assert.equal(manifest.sideEffects, false, `${dir}: expected "sideEffects": false`);
    assert.equal(manifest.main, './dist/index.js', `${dir}: expected main "./dist/index.js"`);
    assert.equal(manifest.types, './dist/index.d.ts', `${dir}: expected types "./dist/index.d.ts"`);
    assert.equal(manifest.publishConfig?.access, 'public', `${dir}: expected publishConfig.access="public"`);
    assert.equal(manifest.publishConfig?.provenance, true, `${dir}: expected publishConfig.provenance=true`);
    assert.equal(manifest.repository?.url, CANONICAL_REPO_URL, `${dir}: unexpected repository.url`);
    assert.equal(manifest.repository?.directory, `packages/${dir}`, `${dir}: unexpected repository.directory`);
    assert.equal(manifest.homepage, CANONICAL_HOMEPAGE, `${dir}: unexpected homepage`);
    assert.equal(manifest.bugs?.url, CANONICAL_BUGS_URL, `${dir}: unexpected bugs.url`);
    assert.ok(manifest.engines?.node, `${dir}: missing engines.node declaration`);

    // Verify exports map
    const rootExport = manifest.exports?.['.'];
    assert.ok(rootExport && typeof rootExport === 'object', `${dir}: missing exports["."]`);
    assert.equal(rootExport.types, './dist/index.d.ts', `${dir}: exports["."].types mismatch`);
    assert.equal(rootExport.import, './dist/index.js', `${dir}: exports["."].import mismatch`);
    assert.equal(rootExport.default, './dist/index.js', `${dir}: exports["."].default mismatch (required for Node 22+ require(esm))`);

    // Verify files whitelist & mandatory metadata files on disk
    assert.ok(Array.isArray(manifest.files), `${dir}: missing files whitelist`);
    for (const requiredFile of ['dist', 'README.md', 'CHANGELOG.md', 'LICENSE']) {
      assert.ok(manifest.files.includes(requiredFile), `${dir}: files whitelist missing "${requiredFile}"`);
    }
    for (const diskFile of ['README.md', 'CHANGELOG.md', 'LICENSE']) {
      await fs.access(path.join(pkgDir, diskFile));
    }

    // Verify internal workspace dependency ranges & topological publish ordering
    for (const [depName, depRange] of Object.entries(manifest.dependencies ?? {})) {
      if (depName.startsWith(`${CANONICAL_SCOPE}/`)) {
        assert.equal(
          depRange,
          `^${expectedVersion}`,
          `${dir}: internal dep "${depName}" has range "${depRange}", expected "^${expectedVersion}"`,
        );
        assert.ok(
          seenNames.has(depName),
          `Topological violation: ${expectedName} depends on ${depName} which appears later in TOPOLOGICAL_PUBLISH_ORDER`,
        );
      }
      const staleScope = '@forge' + 'js';
      if (CANONICAL_SCOPE !== staleScope) {
        assert.equal(
          depName.startsWith(`${staleScope}/`),
          false,
          `${dir}: stale ${staleScope}/* dependency "${depName}" found`,
        );
      }
    }

    // If dist exists, verify every declared export target exists on disk
    const distDir = path.join(pkgDir, 'dist');
    let distVerified = false;
    try {
      await fs.access(distDir);
      for (const [subpath, target] of Object.entries(manifest.exports)) {
        if (typeof target === 'object' && target !== null) {
          for (const condKey of ['import', 'default', 'types']) {
            const relTarget = target[condKey];
            if (typeof relTarget === 'string') {
              await fs.access(path.join(pkgDir, relTarget));
            }
          }
        } else if (typeof target === 'string') {
          await fs.access(path.join(pkgDir, target));
        }
        assert.ok(subpath.startsWith('.'), `${dir}: invalid export key "${subpath}"`);
      }
      if (manifest.bin && typeof manifest.bin === 'object') {
        for (const binRel of Object.values(manifest.bin)) {
          await fs.access(path.join(pkgDir, binRel));
        }
      }
      distVerified = true;
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT' && !distVerified) {
        // dist may not be built yet when running pre-build workspace validation
      } else {
        throw err;
      }
    }

    seenNames.add(expectedName);
    packageSummaries.push({
      name: expectedName,
      version: expectedVersion,
      distVerified,
      dependencyCount: Object.keys(manifest.dependencies ?? {}).length,
    });
  }

  return {
    ok: true,
    canonicalScope: CANONICAL_SCOPE,
    version: expectedVersion,
    repositoryUrl: CANONICAL_REPO_URL,
    packageCount: packageSummaries.length,
    packages: packageSummaries,
  };
}

const isDirectEntry =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (isDirectEntry) {
  const report = await verifyWorkspace();
  console.log(JSON.stringify(report, null, 2));
}
