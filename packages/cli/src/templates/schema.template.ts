import type { GeneratedFileEntry } from '../types.js';
import type { ResolvedGeneratorContext } from './shared.js';

export function renderSchemaTemplate(ctx: ResolvedGeneratorContext): GeneratedFileEntry {
  const { entityPascal, modulePascal, filePrefix, relativeDir } = ctx;
  const lines: string[] = [
    `import { z } from 'zod';`,
    ``,
    `export const ${entityPascal}Schema = z.object({`,
    `  id: z.string().min(1),`,
    `  name: z.string().min(1).max(200),`,
    `  description: z.string().max(1000).optional(),`,
    `  createdAt: z.string(),`,
    `  updatedAt: z.string(),`,
    `});`,
    ``,
    `export const Create${entityPascal}Schema = z.object({`,
    `  name: z.string().min(1).max(200),`,
    `  description: z.string().max(1000).optional(),`,
    `});`,
    ``,
    `export const Update${entityPascal}Schema = z.object({`,
    `  name: z.string().min(1).max(200).optional(),`,
    `  description: z.string().max(1000).optional(),`,
    `});`,
    ``,
    `export const ${entityPascal}IdParamsSchema = z.object({`,
    `  id: z.string().min(1),`,
    `});`,
    ``,
    `export const ${entityPascal}ListQuerySchema = z.object({`,
    `  search: z.string().optional(),`,
    `});`,
    ``,
    `export type ${entityPascal} = z.infer<typeof ${entityPascal}Schema>;`,
    `export type Create${entityPascal}Input = z.infer<typeof Create${entityPascal}Schema>;`,
    `export type Update${entityPascal}Input = z.infer<typeof Update${entityPascal}Schema>;`,
    `export type ${entityPascal}IdParams = z.infer<typeof ${entityPascal}IdParamsSchema>;`,
    `export type ${entityPascal}ListQuery = z.infer<typeof ${entityPascal}ListQuerySchema>;`,
  ];

  if (modulePascal !== entityPascal) {
    lines.push(
      ``,
      `export {`,
      `  ${entityPascal}Schema as ${modulePascal}Schema,`,
      `  Create${entityPascal}Schema as Create${modulePascal}Schema,`,
      `  Update${entityPascal}Schema as Update${modulePascal}Schema,`,
      `  ${entityPascal}IdParamsSchema as ${modulePascal}IdParamsSchema,`,
      `};`,
    );
  }

  lines.push(``);

  return {
    relativePath: `${relativeDir}/${filePrefix}.schema.ts`,
    content: lines.join('\n'),
  };
}
