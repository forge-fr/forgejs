import type { GeneratedFileEntry } from '../types.js';
import { pkgSpec, type ResolvedGeneratorContext } from './shared.js';

export function renderServiceTemplate(ctx: ResolvedGeneratorContext): GeneratedFileEntry {
  const {
    entityPascal,
    modulePascal,
    filePrefix,
    relativeDir,
    crud,
    includeRepository,
    includeSchema,
  } = ctx;

  if (!crud || !includeRepository || !includeSchema) {
    const lines = [
      `import { createToken } from '${pkgSpec('core')}';`,
      ``,
      `export interface ${modulePascal}Service {`,
      `  status(): { readonly name: string; readonly ok: boolean };`,
      `}`,
      ``,
      `export const ${modulePascal}ServiceToken = createToken<${modulePascal}Service>('${modulePascal}Service');`,
      ...(entityPascal !== modulePascal
        ? [`export const ${entityPascal}ServiceToken = ${modulePascal}ServiceToken;`]
        : []),
      ``,
      `export function create${modulePascal}Service(): ${modulePascal}Service {`,
      `  return {`,
      `    status() {`,
      `      return { name: '${filePrefix}', ok: true };`,
      `    },`,
      `  };`,
      `}`,
      ``,
    ];
    return {
      relativePath: `${relativeDir}/${filePrefix}.service.ts`,
      content: lines.join('\n'),
    };
  }

  const lines: string[] = [
    `import { NotFoundError, createToken } from '${pkgSpec('core')}';`,
    `import {`,
    `  create${modulePascal}Repository,`,
    `  type ${modulePascal}Repository,`,
    `} from './${filePrefix}.repository.js';`,
    `import type {`,
    `  ${entityPascal},`,
    `  Create${entityPascal}Input,`,
    `  Update${entityPascal}Input,`,
    `} from './${filePrefix}.schema.js';`,
    ``,
    `export interface ${modulePascal}Service {`,
    `  status(): { readonly name: string; readonly ok: boolean };`,
    `  list(): Promise<readonly ${entityPascal}[]>;`,
    `  getById(id: string): Promise<${entityPascal}>;`,
    `  create(input: Create${entityPascal}Input): Promise<${entityPascal}>;`,
    `  update(id: string, input: Update${entityPascal}Input): Promise<${entityPascal}>;`,
    `  remove(id: string): Promise<{ readonly deleted: true; readonly id: string }>;`,
    `}`,
    ``,
    `export const ${modulePascal}ServiceToken = createToken<${modulePascal}Service>('${modulePascal}Service');`,
    ...(entityPascal !== modulePascal
      ? [`export const ${entityPascal}ServiceToken = ${modulePascal}ServiceToken;`]
      : []),
    ``,
    `export function create${modulePascal}Service(`,
    `  repository: ${modulePascal}Repository = create${modulePascal}Repository(),`,
    `): ${modulePascal}Service {`,
    `  return {`,
    `    status() {`,
    `      return { name: '${filePrefix}', ok: true };`,
    `    },`,
    ``,
    `    async list(): Promise<readonly ${entityPascal}[]> {`,
    `      return repository.findAll();`,
    `    },`,
    ``,
    `    async getById(id: string): Promise<${entityPascal}> {`,
    `      const entity = await repository.findById(id);`,
    `      if (!entity) {`,
    `        throw new NotFoundError(\`${entityPascal} "\${id}" was not found\`);`,
    `      }`,
    `      return entity;`,
    `    },`,
    ``,
    `    async create(input: Create${entityPascal}Input): Promise<${entityPascal}> {`,
    `      return repository.create(input);`,
    `    },`,
    ``,
    `    async update(id: string, input: Update${entityPascal}Input): Promise<${entityPascal}> {`,
    `      const updated = await repository.update(id, input);`,
    `      if (!updated) {`,
    `        throw new NotFoundError(\`${entityPascal} "\${id}" was not found\`);`,
    `      }`,
    `      return updated;`,
    `    },`,
    ``,
    `    async remove(id: string): Promise<{ readonly deleted: true; readonly id: string }> {`,
    `      const removed = await repository.delete(id);`,
    `      if (!removed) {`,
    `        throw new NotFoundError(\`${entityPascal} "\${id}" was not found\`);`,
    `      }`,
    `      return { deleted: true, id };`,
    `    },`,
    `  };`,
    `}`,
    ``,
  ];

  return {
    relativePath: `${relativeDir}/${filePrefix}.service.ts`,
    content: lines.join('\n'),
  };
}
