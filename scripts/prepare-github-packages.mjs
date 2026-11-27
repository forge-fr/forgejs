import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { runPackagingVerification } from './verify-packaging.mjs';

const execFileAsync = promisify(execFile);

export const TOPOLOGICAL_PUBLISH_ORDER = [
  'core',
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

const DEFAULT_SCOPE = '@forge-fr';
const DEFAULT_REGISTRY = 'https://npm.pkg.github.com';

function sanitizeGithubIdentifier(value, label) {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(normalized)) {
    throw new Error(
      `Invalid ${label} "${value}". Use lowercase alphanumeric characters and hyphens only.`,
    );
  }
  return normalized;
}

/**
 * Rewrites a package.json manifest so its npm @scope and GitHub repository coordinates
 * match the target GitHub owner/repository required by GitHub Packages (npm.pkg.github.com).
 */
export function rewriteManifestForGithubOwner(manifest, { owner, repo = 'forgejs', fromScope = DEFAULT_SCOPE }) {
  const cleanOwner = sanitizeGithubIdentifier(owner, 'GitHub owner');
  const cleanRepo = repo.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(cleanRepo)) {
    throw new Error(`Invalid repository name "${repo}".`);
  }

  const targetScope = `@${cleanOwner}`;
  const updated = structuredClone(manifest);

  if (typeof updated.name === 'string' && updated.name.startsWith(`${fromScope}/`)) {
    updated.name = `${targetScope}/${updated.name.slice(fromScope.length + 1)}`;
  }

  for (const depField of ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies']) {
    const depMap = updated[depField];
    if (!depMap || typeof depMap !== 'object') continue;
    const nextMap = {};
    for (const [depName, depRange] of Object.entries(depMap)) {
      if (depName.startsWith(`${fromScope}/`)) {
        const unscoped = depName.slice(fromScope.length + 1);
        nextMap[`${targetScope}/${unscoped}`] = depRange;
      } else {
        nextMap[depName] = depRange;
      }
    }
    updated[depField] = nextMap;
  }

  const repoUrl = `https://github.com/${cleanOwner}/${cleanRepo}.git`;
  if (updated.repository && typeof updated.repository === 'object') {
    updated.repository = {
      ...updated.repository,
      type: 'git',
      url: repoUrl,
    };
  } else {
    updated.repository = { type: 'git', url: repoUrl };
  }

  updated.homepage = `https://github.com/${cleanOwner}/${cleanRepo}#readme`;
  updated.bugs = { url: `https://github.com/${cleanOwner}/${cleanRepo}/issues` };

  return updated;
}

export async function applyGithubOwnerScope({
  rootDir = process.cwd(),
  owner,
  repo = 'forgejs',
  apply = false,
}) {
  const cleanOwner = sanitizeGithubIdentifier(owner, 'GitHub owner');
  const targetScope = `@${cleanOwner}`;
  const changes = [];

  for (const dir of TOPOLOGICAL_PUBLISH_ORDER) {
    const manifestPath = path.join(rootDir, 'packages', dir, 'package.json');
    const raw = await fs.readFile(manifestPath, 'utf8');
    const parsed = JSON.parse(raw);
    const currentScope = typeof parsed.name === 'string' && parsed.name.includes('/')
      ? parsed.name.split('/')[0]
      : DEFAULT_SCOPE;

    const rewritten = rewriteManifestForGithubOwner(parsed, {
      owner: cleanOwner,
      repo,
      fromScope: currentScope,
    });

    const changed = JSON.stringify(parsed) !== JSON.stringify(rewritten);
    changes.push({
      packageDir: dir,
      fromName: parsed.name,
      toName: rewritten.name,
      repositoryUrl: rewritten.repository.url,
      changed,
    });

    if (apply && changed) {
      await fs.writeFile(manifestPath, `${JSON.stringify(rewritten, null, 2)}\n`, 'utf8');
    }
  }

  if (apply) {
    const npmrcExamplePath = path.join(rootDir, '.npmrc.github.example');
    const npmrcContent = [
      '# Salin menjadi .npmrc untuk menginstal atau mempublikasikan paket melalui GitHub Packages.',
      '# Jangan commit file .npmrc yang berisi token asli ke git.',
      '',
      `${targetScope}:registry=${DEFAULT_REGISTRY}`,
      '//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}',
      'always-auth=true',
      '',
    ].join('\n');
    await fs.writeFile(npmrcExamplePath, npmrcContent, 'utf8');
  }

  return {
    owner: cleanOwner,
    repo,
    targetScope,
    applied: apply,
    packages: changes,
  };
}

export async function buildAllPackages(rootDir = process.cwd()) {
  const tscBin = path.join(rootDir, 'node_modules', '.bin', 'tsc');
  const tsconfigs = TOPOLOGICAL_PUBLISH_ORDER.map((pkg) => path.join('packages', pkg, 'tsconfig.json'));
  await execFileAsync(tscBin, ['-b', '--force', ...tsconfigs], { cwd: rootDir });
}

export async function packGithubPackagesBundle({
  rootDir = process.cwd(),
  outDir = path.join(rootDir, 'dist-packages'),
}) {
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });

  const entries = [];
  const checksumLines = [];

  for (const dir of TOPOLOGICAL_PUBLISH_ORDER) {
    const pkgDir = path.join(rootDir, 'packages', dir);
    const { stdout } = await execFileAsync(
      'npm',
      ['pack', '--json', '--pack-destination', outDir],
      { cwd: pkgDir },
    );

    const parsed = JSON.parse(stdout);
    const info = parsed[0];
    if (!info?.filename) {
      throw new Error(`npm pack failed to emit tarball metadata for packages/${dir}`);
    }

    const tgzPath = path.join(outDir, info.filename);
    const bytes = await fs.readFile(tgzPath);
    const sha256 = createHash('sha256').update(bytes).digest('hex');

    checksumLines.push(`${sha256}  ${info.filename}`);
    entries.push({
      order: entries.length + 1,
      dir,
      name: info.name,
      version: info.version,
      filename: info.filename,
      sizeBytes: info.size,
      unpackedSizeBytes: info.unpackedSize,
      entryCount: info.entryCount,
      sha256,
    });
  }

  await fs.writeFile(path.join(outDir, 'SHA256SUMS.txt'), `${checksumLines.join('\n')}\n`, 'utf8');
  await fs.writeFile(
    path.join(outDir, 'release-manifest.json'),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        packageCount: entries.length,
        topologicalOrder: TOPOLOGICAL_PUBLISH_ORDER,
        packages: entries,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  return {
    outDir,
    packageCount: entries.length,
    packages: entries,
  };
}

export async function publishPackagesToGithub({
  rootDir = process.cwd(),
  registry = DEFAULT_REGISTRY,
  tag = 'next',
  dryRun = true,
}) {
  const results = [];

  for (const dir of TOPOLOGICAL_PUBLISH_ORDER) {
    const pkgDir = path.join(rootDir, 'packages', dir);
    const manifest = JSON.parse(await fs.readFile(path.join(pkgDir, 'package.json'), 'utf8'));

    const args = [
      'publish',
      pkgDir,
      '--registry',
      registry,
      '--tag',
      tag,
      '--provenance=false',
    ];
    if (dryRun) {
      args.push('--dry-run');
    }

    const { stdout, stderr } = await execFileAsync('npm', args, { cwd: rootDir });
    results.push({
      dir,
      name: manifest.name,
      version: manifest.version,
      registry,
      tag,
      dryRun,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    });
  }

  return results;
}

function parseArgs(argv) {
  const flags = {
    build: false,
    verify: false,
    pack: false,
    publish: false,
    dryRun: false,
    apply: false,
    outDir: 'dist-packages',
    owner: '',
    repo: 'forgejs',
    registry: DEFAULT_REGISTRY,
    tag: 'next',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--build') flags.build = true;
    else if (arg === '--verify') flags.verify = true;
    else if (arg === '--pack') flags.pack = true;
    else if (arg === '--publish') flags.publish = true;
    else if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--apply') flags.apply = true;
    else if (arg === '--out-dir' && argv[i + 1]) flags.outDir = argv[++i];
    else if (arg === '--owner' && argv[i + 1]) flags.owner = argv[++i];
    else if (arg === '--repo' && argv[i + 1]) flags.repo = argv[++i];
    else if (arg === '--registry' && argv[i + 1]) flags.registry = argv[++i];
    else if (arg === '--tag' && argv[i + 1]) flags.tag = argv[++i];
  }

  if (!flags.build && !flags.verify && !flags.pack && !flags.publish && !flags.owner) {
    flags.build = true;
    flags.pack = true;
  }

  return flags;
}

const isDirectEntry =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (isDirectEntry) {
  const rootDir = process.cwd();
  const flags = parseArgs(process.argv.slice(2));
  const summary = {};

  if (flags.owner) {
    summary.scopeUpdate = await applyGithubOwnerScope({
      rootDir,
      owner: flags.owner,
      repo: flags.repo,
      apply: flags.apply,
    });
  }

  if (flags.build) {
    await buildAllPackages(rootDir);
    summary.builtPackages = TOPOLOGICAL_PUBLISH_ORDER.length;
  }

  if (flags.verify) {
    summary.verification = await runPackagingVerification();
  }

  if (flags.pack) {
    summary.bundle = await packGithubPackagesBundle({
      rootDir,
      outDir: path.resolve(rootDir, flags.outDir),
    });
  }

  if (flags.publish) {
    summary.published = await publishPackagesToGithub({
      rootDir,
      registry: flags.registry,
      tag: flags.tag,
      dryRun: flags.dryRun,
    });
  }

  console.log(JSON.stringify(summary, null, 2));
}
