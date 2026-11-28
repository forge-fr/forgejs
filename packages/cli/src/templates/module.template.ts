import type { GeneratedFileEntry } from '../types.js';
import { pkgSpec, type ResolvedGeneratorContext } from './shared.js';

export function renderModuleTemplate(ctx: ResolvedGeneratorContext): GeneratedFileEntry {
  const { modulePascal, moduleCamel, filePrefix, relativeDir, includeRepository } = ctx;

  if (!includeRepository) {
    const lines = [
      `import { defineModule } from '${pkgSpec('core')}';`,
      `import { ${modulePascal}ServiceToken, create${modulePascal}Service } from './${filePrefix}.service.js';`,
      ``,
      `export const ${moduleCamel}Module = defineModule({`,
      `  name: '${filePrefix}',`,
      `  providers: [`,
      `    {`,
      `      token: ${modulePascal}ServiceToken,`,
      `      scope: 'singleton',`,
      `      useFactory: () => create${modulePascal}Service(),`,
      `    },`,
      `  ],`,
      `  exports: [${modulePascal}ServiceToken],`,
      `});`,
      ``,
    ];
    return {
      relativePath: `${relativeDir}/${filePrefix}.module.ts`,
      content: lines.join('\n'),
    };
  }

  const lines: string[] = [
    `import { defineModule } from '${pkgSpec('core')}';`,
    `import {`,
    `  ${modulePascal}RepositoryToken,`,
    `  create${modulePascal}Repository,`,
    `} from './${filePrefix}.repository.js';`,
    `import {`,
    `  ${modulePascal}ServiceToken,`,
    `  create${modulePascal}Service,`,
    `} from './${filePrefix}.service.js';`,
    ``,
    `export const ${moduleCamel}Module = defineModule({`,
    `  name: '${filePrefix}',`,
    `  providers: [`,
    `    {`,
    `      token: ${modulePascal}RepositoryToken,`,
    `      scope: 'singleton',`,
    `      useFactory: () => create${modulePascal}Repository(),`,
    `    },`,
    `    {`,
    `      token: ${modulePascal}ServiceToken,`,
    `      scope: 'singleton',`,
    `      useFactory: (container) =>`,
    `        create${modulePascal}Service(container.resolve(${modulePascal}RepositoryToken)),`,
    `    },`,
    `  ],`,
    `  exports: [${modulePascal}ServiceToken, ${modulePascal}RepositoryToken],`,
    `});`,
    ``,
  ];

  return {
    relativePath: `${relativeDir}/${filePrefix}.module.ts`,
    content: lines.join('\n'),
  };
}
