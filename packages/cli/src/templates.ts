import { CliError } from './errors.js';
import { validateProjectName, validateSymbolName } from './safety.js';
import type {
  GeneratedFileEntry,
  GeneratorArtifactKind,
  ProjectRuntimeTarget,
  ProjectTemplateKind,
} from './types.js';

const FORGE_SCOPE = '@forge-fr';

function pkgSpec(shortName: string): string {
  return `${FORGE_SCOPE}/${shortName}`;
}

export interface ProjectTemplateOptions {
  readonly projectName: string;
  readonly template?: ProjectTemplateKind;
  readonly runtime?: ProjectRuntimeTarget;
  readonly port?: number;
}

export function buildProjectTemplateFiles(
  options: ProjectTemplateOptions,
): readonly GeneratedFileEntry[] {
  const projectName = validateProjectName(options.projectName);
  const template = options.template ?? 'api';
  const runtime = options.runtime ?? 'node';
  const port = options.port ?? 3000;

  if (!['minimal', 'api', 'modular'].includes(template)) {
    throw new CliError(
      'CLI_TEMPLATE_ERROR',
      `Unknown template "${template}". Choose minimal, api, or modular.`,
    );
  }

  const dependencies: Record<string, string> = {
    [pkgSpec('core')]: '^1.0.0-rc.2',
    [pkgSpec('http')]: '^1.0.0-rc.2',
    ...(runtime === 'bun'
      ? { [pkgSpec('bun')]: '^1.0.0-rc.2' }
      : runtime === 'edge'
        ? { [pkgSpec('edge')]: '^1.0.0-rc.2' }
        : { [pkgSpec('node')]: '^1.0.0-rc.2' }),
  };

  if (template === 'api') {
    dependencies[pkgSpec('openapi')] = '^1.0.0-rc.2';
    dependencies[pkgSpec('security')] = '^1.0.0-rc.2';
    dependencies[pkgSpec('validation')] = '^1.0.0-rc.2';
    dependencies['zod'] = '^4.6.7';
  }

  const adapterImport =
    runtime === 'bun'
      ? `import { createBunAdapter } from '${pkgSpec('bun')}';`
      : runtime === 'edge'
        ? `import { createCloudflareWorkerHandler } from '${pkgSpec('edge')}';`
        : `import { createNodeAdapter } from '${pkgSpec('node')}';`;
  const adapterFactory = runtime === 'bun' ? 'createBunAdapter()' : 'createNodeAdapter()';

  const scripts =
    runtime === 'bun'
      ? {
          dev: 'bun --watch src/index.ts',
          build: 'tsc -b tsconfig.json',
          start: 'bun dist/index.js',
          typecheck: 'tsc -p tsconfig.json --noEmit',
          test: 'bun test',
        }
      : runtime === 'edge'
        ? {
            build: 'tsc -b tsconfig.json',
            typecheck: 'tsc -p tsconfig.json --noEmit',
            test: 'vitest run',
          }
        : {
            dev: 'tsx watch src/index.ts',
            build: 'tsc -b tsconfig.json',
            start: 'node dist/index.js',
            typecheck: 'tsc -p tsconfig.json --noEmit',
            test: 'vitest run',
          };

  const pkgJson = {
    name: projectName,
    version: '0.1.0',
    private: true,
    type: 'module',
    scripts,
    dependencies,
    devDependencies: {
      [pkgSpec('testing')]: '^1.0.0-rc.2',
      typescript: '^5.8.0',
      ...(runtime === 'node'
        ? { '@types/node': '^22.15.0', tsx: '^4.19.0', vitest: '^3.1.0' }
        : runtime === 'edge'
          ? { vitest: '^3.1.0' }
          : {}),
    },
  };

  const tsconfig = {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      exactOptionalPropertyTypes: true,
      noUncheckedIndexedAccess: true,
      verbatimModuleSyntax: true,
      rootDir: './src',
      outDir: './dist',
      skipLibCheck: true,
    },
    include: ['src/**/*.ts'],
    exclude: ['dist', 'tests'],
  };

  const entrySource = buildEntrySource({
    projectName,
    template,
    runtime,
    port,
    adapterImport,
    adapterFactory,
  });

  const files: GeneratedFileEntry[] = [
    { relativePath: 'package.json', content: `${JSON.stringify(pkgJson, null, 2)}\n` },
    { relativePath: 'tsconfig.json', content: `${JSON.stringify(tsconfig, null, 2)}\n` },
    { relativePath: '.env.example', content: `PORT=${port}\nHOST=127.0.0.1\nNODE_ENV=development\n` },
    { relativePath: '.gitignore', content: `node_modules\ndist\n.env\n.env.local\n` },
    {
      relativePath: 'README.md',
      content: `# ${projectName}\n\nBuilt with ForgeJS (${template} template, ${runtime} runtime).\n\n\`\`\`bash\nforge dev\nforge build\nforge start\n\`\`\`\n`,
    },
    { relativePath: 'src/index.ts', content: entrySource },
    {
      relativePath: 'tests/app.test.ts',
      content: `import { createApp } from '../src/app.js';\nimport { createTestClient } from '${pkgSpec('testing')}';\n\nconst app = createApp();\nconst client = createTestClient(app);\nconst res = await client.get('/health');\nif (res.status !== 200) {\n  throw new Error('Expected /health to return 200');\n}\nawait client.close();\n`,
    },
  ];

  if (template === 'api') {
    files.push({
      relativePath: 'src/app.ts',
      content: [
        `import { createHttpApp, type ForgeHttpApp } from '${pkgSpec('http')}';`,
        `import { registerOpenApiRoutes, validatedOpenApiHandler } from '${pkgSpec('openapi')}';`,
        `import { createSecurityHeadersMiddleware } from '${pkgSpec('security')}';`,
        `import { z } from 'zod';`,
        ``,
        `export function createApp(): ForgeHttpApp {`,
        `  const app = createHttpApp();`,
        `  app.use(createSecurityHeadersMiddleware());`,
        ``,
        `  app.get('/health', (ctx) => ctx.json({ status: 'ok', service: '${projectName}' }));`,
        `  app.get(`,
        `    '/hello/:name',`,
        `    validatedOpenApiHandler(`,
        `      {`,
        `        params: z.object({ name: z.string() }),`,
        `        response: z.object({ message: z.string() }),`,
        `      },`,
        `      (_ctx, input) => ({ message: \`Hello, \${input.params.name}!\` }),`,
        `      { summary: 'Greet user by name', tags: ['General'] },`,
        `    ),`,
        `  );`,
        ``,
        `  registerOpenApiRoutes(app, {`,
        `    title: '${projectName}',`,
        `    version: '0.1.0',`,
        `  });`,
        ``,
        `  return app;`,
        `}`,
        ``,
      ].join('\n'),
    });
  } else if (template === 'modular') {
    const appFile = generateArtifactFiles('module', 'app');
    const healthController = generateArtifactFiles('controller', 'health');
    const healthService = generateArtifactFiles('service', 'health');
    files.push(
      {
        relativePath: 'src/app.ts',
        content: [
          `import { createHttpApp, type ForgeHttpApp } from '${pkgSpec('http')}';`,
          `import { registerHealthController } from './health/health.controller.js';`,
          `import { healthModule } from './health/health.module.js';`,
          ``,
          `export function createApp(): ForgeHttpApp {`,
          `  const app = createHttpApp();`,
          `  app.registerModule(healthModule);`,
          `  registerHealthController(app);`,
          `  return app;`,
          `}`,
          ``,
        ].join('\n'),
      },
      {
        relativePath: 'src/health/health.module.ts',
        content: [
          `import { defineModule } from '${pkgSpec('core')}';`,
          `import { HealthServiceToken, createHealthService } from './health.service.js';`,
          ``,
          `export const healthModule = defineModule({`,
          `  name: 'health',`,
          `  providers: [`,
          `    {`,
          `      token: HealthServiceToken,`,
          `      scope: 'singleton',`,
          `      useFactory: () => createHealthService(),`,
          `    },`,
          `  ],`,
          `  exports: [HealthServiceToken],`,
          `});`,
          ``,
        ].join('\n'),
      },
      healthController,
      healthService,
      appFile,
    );
  } else {
    files.push({
      relativePath: 'src/app.ts',
      content: [
        `import { createHttpApp, type ForgeHttpApp } from '${pkgSpec('http')}';`,
        ``,
        `export function createApp(): ForgeHttpApp {`,
        `  const app = createHttpApp();`,
        `  app.get('/health', (ctx) => ctx.json({ status: 'ok', service: '${projectName}' }));`,
        `  return app;`,
        `}`,
        ``,
      ].join('\n'),
    });
  }

  return files;
}

function buildEntrySource(opts: {
  readonly projectName: string;
  readonly template: ProjectTemplateKind;
  readonly runtime: ProjectRuntimeTarget;
  readonly port: number;
  readonly adapterImport: string;
  readonly adapterFactory: string;
}): string {
  if (opts.runtime === 'edge') {
    return [
      opts.adapterImport,
      `import { createApp } from './app.js';`,
      ``,
      `const app = createApp();`,
      `export default createCloudflareWorkerHandler(app, { trustCfConnectingIp: true });`,
      ``,
    ].join('\n');
  }

  return [
    `import { createHttpApp } from '${pkgSpec('http')}';`,
    opts.adapterImport,
    `import { createApp } from './app.js';`,
    ``,
    `const rawPort = Number(process.env['PORT'] ?? '${opts.port}');`,
    `const port = Number.isInteger(rawPort) && rawPort > 0 && rawPort <= 65535 ? rawPort : ${opts.port};`,
    `const host = process.env['HOST'] ?? '127.0.0.1';`,
    ``,
    `const inner = createApp();`,
    `const serverApp = createHttpApp({ adapter: ${opts.adapterFactory} });`,
    `serverApp.use((ctx) => inner.fetch(ctx.request));`,
    ``,
    `const addr = await serverApp.listen({ host, port });`,
    `console.log('${opts.projectName} (${opts.template}) listening at ' + addr.url);`,
    ``,
  ].join('\n');
}

export function generateArtifactFiles(
  kind: GeneratorArtifactKind,
  rawName: string,
): GeneratedFileEntry {
  const sym = validateSymbolName(rawName);

  switch (kind) {
    case 'module':
      return {
        relativePath: `src/${sym.kebab}/${sym.kebab}.module.ts`,
        content: [
          `import { defineModule } from '${pkgSpec('core')}';`,
          `import { ${sym.pascal}ServiceToken, create${sym.pascal}Service } from './${sym.kebab}.service.js';`,
          ``,
          `export const ${sym.camel}Module = defineModule({`,
          `  name: '${sym.kebab}',`,
          `  providers: [`,
          `    {`,
          `      token: ${sym.pascal}ServiceToken,`,
          `      scope: 'singleton',`,
          `      useFactory: () => create${sym.pascal}Service(),`,
          `    },`,
          `  ],`,
          `  exports: [${sym.pascal}ServiceToken],`,
          `});`,
          ``,
        ].join('\n'),
      };

    case 'controller':
      return {
        relativePath: `src/${sym.kebab}/${sym.kebab}.controller.ts`,
        content: [
          `import type { ForgeHttpApp } from '${pkgSpec('http')}';`,
          `import { ${sym.pascal}ServiceToken } from './${sym.kebab}.service.js';`,
          ``,
          `export function register${sym.pascal}Controller(app: ForgeHttpApp): void {`,
          `  app.group('/${sym.kebab}', (group) => {`,
          `    group.get('/', (ctx) => {`,
          `      const service = ctx.resolve(${sym.pascal}ServiceToken);`,
          `      return ctx.json(service.status());`,
          `    });`,
          `  });`,
          `}`,
          ``,
        ].join('\n'),
      };

    case 'service':
      return {
        relativePath: `src/${sym.kebab}/${sym.kebab}.service.ts`,
        content: [
          `import { createToken } from '${pkgSpec('core')}';`,
          ``,
          `export interface ${sym.pascal}Service {`,
          `  status(): { readonly name: string; readonly ok: boolean };`,
          `}`,
          ``,
          `export const ${sym.pascal}ServiceToken = createToken<${sym.pascal}Service>('${sym.pascal}Service');`,
          ``,
          `export function create${sym.pascal}Service(): ${sym.pascal}Service {`,
          `  return {`,
          `    status() {`,
          `      return { name: '${sym.kebab}', ok: true };`,
          `    },`,
          `  };`,
          `}`,
          ``,
        ].join('\n'),
      };
  }
}
