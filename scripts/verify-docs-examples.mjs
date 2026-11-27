import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DOCUMENTED_FILES = [
  'README.md',
  'docs/quick-start.md',
  'docs/architecture.md',
  'docs/http-and-validation.md',
  'docs/data-and-auth.md',
  'docs/security-and-observability.md',
  'docs/infrastructure-and-cli.md',
  'docs/id/quick-start.md',
  'docs/id/architecture.md',
  'docs/id/security.md',
];

export function extractDocExamples(rootDir = ROOT_DIR) {
  const examples = [];
  const blockRegex = /```ts forge-example\r?\n([\s\S]*?)```/g;

  for (const relPath of DOCUMENTED_FILES) {
    const absPath = path.join(rootDir, relPath);
    if (!fs.existsSync(absPath)) {
      throw new Error(`Missing required documentation file: ${relPath}`);
    }
    const content = fs.readFileSync(absPath, 'utf8');
    const fileExamples = [];
    let match;
    let blockIdx = 0;

    while ((match = blockRegex.exec(content)) !== null) {
      blockIdx += 1;
      const code = match[1] ?? '';
      if (code.trim().length === 0) {
        throw new Error(`Empty forge-example block #${blockIdx} in ${relPath}`);
      }
      fileExamples.push({
        id: `${relPath.replace(/[^a-zA-Z0-9]+/g, '_')}__${blockIdx}`,
        sourceFile: relPath,
        index: blockIdx,
        code,
      });
    }

    if (fileExamples.length === 0) {
      throw new Error(`Documentation file ${relPath} contains zero ts forge-example blocks`);
    }

    examples.push(...fileExamples);
  }

  return examples;
}

export async function verifyDocExamples({
  rootDir = ROOT_DIR,
  runTypecheck = true,
  runtimes = ['node', 'bun'],
} = {}) {
  const examples = extractDocExamples(rootDir);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgejs-docs-examples-'));

  try {
    fs.writeFileSync(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: 'forgejs-docs-check', private: true, type: 'module' }, null, 2),
      'utf8',
    );
    fs.symlinkSync(path.join(rootDir, 'node_modules'), path.join(tempDir, 'node_modules'), 'dir');

    const tsFiles = [];
    const outDir = path.join(tempDir, 'dist');
    fs.mkdirSync(outDir, { recursive: true });

    for (const ex of examples) {
      const tsPath = path.join(tempDir, `${ex.id}.ts`);
      fs.writeFileSync(tsPath, ex.code, 'utf8');
      tsFiles.push(tsPath);
    }

    const tsconfigPath = path.join(tempDir, 'tsconfig.json');
    fs.writeFileSync(
      tsconfigPath,
      JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            strict: true,
            exactOptionalPropertyTypes: true,
            noUncheckedIndexedAccess: true,
            skipLibCheck: true,
            noEmit: true,
            types: ['node'],
          },
          include: tsFiles.map((f) => path.basename(f)),
        },
        null,
        2,
      ),
      'utf8',
    );

    if (runTypecheck) {
      const tscBin = path.join(rootDir, 'node_modules/.bin/tsc');
      const tscResult = spawnSync(tscBin, ['--noEmit', '-p', tsconfigPath], {
        cwd: tempDir,
        encoding: 'utf8',
      });
      if (tscResult.status !== 0) {
        throw new Error(
          `Documentation examples failed TypeScript check:\n${tscResult.stdout}\n${tscResult.stderr}`,
        );
      }
    }

    await esbuild.build({
      entryPoints: tsFiles,
      outdir: outDir,
      format: 'esm',
      platform: 'node',
      target: 'node22',
      bundle: false,
      outExtension: { '.js': '.mjs' },
    });

    const executions = [];
    for (const runtime of runtimes) {
      for (const ex of examples) {
        const jsPath = path.join(outDir, `${ex.id}.mjs`);
        const runResult = spawnSync(runtime, [jsPath], {
          cwd: tempDir,
          encoding: 'utf8',
          timeout: 20_000,
        });
        if (runResult.status !== 0) {
          throw new Error(
            `Doc example ${ex.sourceFile} (#${ex.index}) failed on ${runtime}:\n${runResult.stdout}\n${runResult.stderr}`,
          );
        }
        executions.push({ id: ex.id, sourceFile: ex.sourceFile, runtime });
      }
    }

    return {
      filesChecked: DOCUMENTED_FILES.length,
      examplesCount: examples.length,
      executionsCount: executions.length,
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

const isCli =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isCli) {
  const onlyRuntime = process.argv.includes('--node-only')
    ? ['node']
    : process.argv.includes('--bun-only')
      ? ['bun']
      : ['node', 'bun'];
  const summary = await verifyDocExamples({ runtimes: onlyRuntime });
  console.log(JSON.stringify(summary));
}
