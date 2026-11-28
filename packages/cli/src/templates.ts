import { CliError } from './errors.js';
import { validateProjectName } from './safety.js';
import { renderControllerTemplate } from './templates/controller.template.js';
import { renderModuleTemplate } from './templates/module.template.js';
import { renderRepositoryTemplate } from './templates/repository.template.js';
import { renderSchemaTemplate } from './templates/schema.template.js';
import { renderServiceTemplate } from './templates/service.template.js';
import { resolveGeneratorContext } from './templates/shared.js';
import type {
  GeneratedFileEntry,
  GeneratorArtifactKind,
  GeneratorOptions,
  ProjectRuntimeTarget,
  ProjectTemplateKind,
} from './types.js';

const FORGE_SCOPE = '@forge-fr';

function pkgSpec(pkgName: string): string {
  return `${FORGE_SCOPE}/${pkgName}`;
}

export {
  renderControllerTemplate,
  renderModuleTemplate,
  renderRepositoryTemplate,
  renderSchemaTemplate,
  renderServiceTemplate,
  resolveGeneratorContext,
};
export type { ResolvedGeneratorContext } from './templates/shared.js';

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
    [pkgSpec('core')]: '^1.0.0',
    [pkgSpec('http')]: '^1.0.0',
    ...(runtime === 'bun'
      ? { [pkgSpec('bun')]: '^1.0.0' }
      : runtime === 'edge'
        ? { [pkgSpec('edge')]: '^1.0.0' }
        : { [pkgSpec('node')]: '^1.0.0' }),
  };

  if (template === 'api' || template === 'modular') {
    dependencies[pkgSpec('validation')] = '^1.0.0';
    dependencies['zod'] = '^4.6.7';
  }
  if (template === 'api') {
    dependencies[pkgSpec('openapi')] = '^1.0.0';
    dependencies[pkgSpec('security')] = '^1.0.0';
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
      [pkgSpec('testing')]: '^1.0.0',
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

/**
 * Generates a single artifact file (`module`, `controller`, `service`, `repository`, or `schema`).
 * Preserves backward-compatible defaults (`modulesDir: 'src'`, `naming: 'exact'`) when called with 2 arguments.
 */
export function generateArtifactFiles(
  kind: GeneratorArtifactKind,
  rawName: string,
  options: GeneratorOptions = {},
): GeneratedFileEntry {
  const ctx = resolveGeneratorContext(rawName, options, {
    modulesDir: 'src',
    naming: 'exact',
    crud: options.crud ?? false,
    includeRepository: options.includeRepository ?? false,
    includeSchema: options.includeSchema ?? false,
    includeController: options.includeController ?? true,
  });

  switch (kind) {
    case 'schema':
      return renderSchemaTemplate(ctx);
    case 'repository':
      return renderRepositoryTemplate(ctx);
    case 'service':
      return renderServiceTemplate(ctx);
    case 'controller':
      return renderControllerTemplate(ctx);
    case 'module':
    case 'resource':
      return renderModuleTemplate(ctx);
  }
}

/**
 * Generates the complete 5-file ForgeJS feature module structure:
 * `<modulesDir>/<name>/<name>.schema.ts`
 * `<modulesDir>/<name>/<name>.repository.ts`
 * `<modulesDir>/<name>/<name>.service.ts`
 * `<modulesDir>/<name>/<name>.controller.ts`
 * `<modulesDir>/<name>/<name>.module.ts`
 */
export function generateModuleBundle(
  rawName: string,
  options: GeneratorOptions = {},
): readonly GeneratedFileEntry[] {
  const ctx = resolveGeneratorContext(rawName, options, {
    modulesDir: 'src/modules',
    naming: 'plural',
    crud: true,
    includeRepository: true,
    includeSchema: true,
    includeController: true,
  });

  const files: GeneratedFileEntry[] = [];
  if (ctx.includeSchema) {
    files.push(renderSchemaTemplate(ctx));
  }
  if (ctx.includeRepository) {
    files.push(renderRepositoryTemplate(ctx));
  }
  files.push(renderServiceTemplate(ctx));
  if (ctx.includeController) {
    files.push(renderControllerTemplate(ctx));
  }
  files.push(renderModuleTemplate(ctx));
  return files;
}

/**
 * Dispatches any `GeneratorArtifactKind` (`module`, `resource`, `schema`, `repository`, `service`, `controller`)
 * to either the full modular bundle or the specific artifact file inside `options.modulesDir ?? 'src/modules'`.
 */
export function generateCodeArtifacts(
  kind: GeneratorArtifactKind,
  rawName: string,
  options: GeneratorOptions = {},
): readonly GeneratedFileEntry[] {
  if (kind === 'resource' || (kind === 'module' && options.singleFile !== true)) {
    return generateModuleBundle(rawName, options);
  }

  const ctx = resolveGeneratorContext(rawName, options, {
    modulesDir: 'src/modules',
    naming: 'plural',
    crud: options.crud ?? false,
    includeRepository: options.includeRepository ?? false,
    includeSchema: options.includeSchema ?? false,
    includeController: true,
  });

  switch (kind) {
    case 'schema':
      return [renderSchemaTemplate(ctx)];
    case 'repository':
      return [renderRepositoryTemplate(ctx)];
    case 'service':
      return [renderServiceTemplate(ctx)];
    case 'controller':
      return [renderControllerTemplate(ctx)];
    case 'module':
      return [renderModuleTemplate(ctx)];
  }
}

/**
 * Injects module and controller registration into an existing `src/app.ts` source string.
 */
export function injectModuleRegistrationInAppSource(
  appSource: string,
  rawName: string,
  options: GeneratorOptions = {},
): string {
  const ctx = resolveGeneratorContext(rawName, options, {
    modulesDir: 'src/modules',
    naming: 'plural',
  });

  const relFromSrc = ctx.relativeDir.startsWith('src/')
    ? `./${ctx.relativeDir.slice('src/'.length)}`
    : `./${ctx.relativeDir}`;

  const moduleImport = `import { ${ctx.moduleCamel}Module } from '${relFromSrc}/${ctx.filePrefix}.module.js';`;
  const controllerImport = `import { register${ctx.modulePascal}Controller } from '${relFromSrc}/${ctx.filePrefix}.controller.js';`;
  const registerModuleCall = `  app.registerModule(${ctx.moduleCamel}Module);`;
  const registerControllerCall = `  register${ctx.modulePascal}Controller(app);`;

  let updated = appSource;
  const importsToAdd: string[] = [];
  if (!updated.includes(`${ctx.moduleCamel}Module`)) {
    importsToAdd.push(moduleImport);
  }
  if (ctx.includeController && !updated.includes(`register${ctx.modulePascal}Controller`)) {
    importsToAdd.push(controllerImport);
  }

  if (importsToAdd.length > 0) {
    updated = `${importsToAdd.join('\n')}\n${updated}`;
  }

  const returnAppIdx = updated.lastIndexOf('return app;');
  if (returnAppIdx >= 0) {
    const callsToAdd: string[] = [];
    if (!appSource.includes(registerModuleCall.trim())) {
      callsToAdd.push(registerModuleCall);
    }
    if (ctx.includeController && !appSource.includes(registerControllerCall.trim())) {
      callsToAdd.push(registerControllerCall);
    }
    if (callsToAdd.length > 0) {
      const lineStart = updated.lastIndexOf('\n', returnAppIdx);
      const insertPos = lineStart >= 0 ? lineStart + 1 : returnAppIdx;
      updated = `${updated.slice(0, insertPos)}${callsToAdd.join('\n')}\n${updated.slice(insertPos)}`;
    }
  }

  return updated;
}
