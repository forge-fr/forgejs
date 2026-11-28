import type { GeneratedFileEntry } from '../types.js';
import { pkgSpec, type ResolvedGeneratorContext } from './shared.js';

export function renderRepositoryTemplate(ctx: ResolvedGeneratorContext): GeneratedFileEntry {
  const { entityPascal, modulePascal, filePrefix, relativeDir, includeSchema } = ctx;
  const lines: string[] = [`import { createToken } from '${pkgSpec('core')}';`];

  if (includeSchema) {
    lines.push(
      `import type {`,
      `  ${entityPascal},`,
      `  Create${entityPascal}Input,`,
      `  Update${entityPascal}Input,`,
      `} from './${filePrefix}.schema.js';`,
    );
  } else {
    lines.push(
      ``,
      `export interface ${entityPascal} {`,
      `  readonly id: string;`,
      `  readonly name: string;`,
      `  readonly description?: string | undefined;`,
      `  readonly createdAt: string;`,
      `  readonly updatedAt: string;`,
      `}`,
      ``,
      `export interface Create${entityPascal}Input {`,
      `  readonly name: string;`,
      `  readonly description?: string | undefined;`,
      `}`,
      ``,
      `export interface Update${entityPascal}Input {`,
      `  readonly name?: string | undefined;`,
      `  readonly description?: string | undefined;`,
      `}`,
    );
  }

  lines.push(
    ``,
    `export interface ${modulePascal}Repository {`,
    `  findAll(): Promise<readonly ${entityPascal}[]>;`,
    `  findById(id: string): Promise<${entityPascal} | undefined>;`,
    `  create(input: Create${entityPascal}Input): Promise<${entityPascal}>;`,
    `  update(id: string, input: Update${entityPascal}Input): Promise<${entityPascal} | undefined>;`,
    `  delete(id: string): Promise<boolean>;`,
    `}`,
    ``,
    `export const ${modulePascal}RepositoryToken = createToken<${modulePascal}Repository>('${modulePascal}Repository');`,
  );

  if (entityPascal !== modulePascal) {
    lines.push(`export const ${entityPascal}RepositoryToken = ${modulePascal}RepositoryToken;`);
  }

  lines.push(
    ``,
    `export function create${modulePascal}Repository(): ${modulePascal}Repository {`,
    `  const store = new Map<string, ${entityPascal}>();`,
    `  let sequence = 0;`,
    ``,
    `  return {`,
    `    async findAll(): Promise<readonly ${entityPascal}[]> {`,
    `      return Array.from(store.values());`,
    `    },`,
    ``,
    `    async findById(id: string): Promise<${entityPascal} | undefined> {`,
    `      return store.get(id);`,
    `    },`,
    ``,
    `    async create(input: Create${entityPascal}Input): Promise<${entityPascal}> {`,
    `      sequence += 1;`,
    `      const now = new Date().toISOString();`,
    `      const entity: ${entityPascal} = {`,
    `        id: \`${ctx.symbol.singularKebab}_\${sequence}\`,`,
    `        name: input.name,`,
    `        ...(input.description !== undefined ? { description: input.description } : {}),`,
    `        createdAt: now,`,
    `        updatedAt: now,`,
    `      };`,
    `      store.set(entity.id, entity);`,
    `      return entity;`,
    `    },`,
    ``,
    `    async update(id: string, input: Update${entityPascal}Input): Promise<${entityPascal} | undefined> {`,
    `      const existing = store.get(id);`,
    `      if (!existing) {`,
    `        return undefined;`,
    `      }`,
    `      const updated: ${entityPascal} = {`,
    `        ...existing,`,
    `        ...(input.name !== undefined ? { name: input.name } : {}),`,
    `        ...(input.description !== undefined ? { description: input.description } : {}),`,
    `        updatedAt: new Date().toISOString(),`,
    `      };`,
    `      store.set(id, updated);`,
    `      return updated;`,
    `    },`,
    ``,
    `    async delete(id: string): Promise<boolean> {`,
    `      return store.delete(id);`,
    `    },`,
    `  };`,
    `}`,
    ``,
  );

  return {
    relativePath: `${relativeDir}/${filePrefix}.repository.ts`,
    content: lines.join('\n'),
  };
}
