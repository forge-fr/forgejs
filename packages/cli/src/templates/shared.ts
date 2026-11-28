import { inflectSymbolName } from '../safety.js';
import type { GeneratorNamingMode, GeneratorOptions, InflectedSymbolName } from '../types.js';

export const FORGE_SCOPE = '@forge-fr';

export function pkgSpec(shortName: string): string {
  return `${FORGE_SCOPE}/${shortName}`;
}

export interface ResolvedGeneratorContext {
  readonly symbol: InflectedSymbolName;
  readonly modulesDir: string;
  readonly naming: GeneratorNamingMode;
  readonly filePrefix: string;
  readonly relativeDir: string;
  readonly modulePascal: string;
  readonly moduleCamel: string;
  readonly entityPascal: string;
  readonly entityCamel: string;
  readonly routePath: string;
  readonly crud: boolean;
  readonly includeRepository: boolean;
  readonly includeSchema: boolean;
  readonly includeController: boolean;
}

export function resolveGeneratorContext(
  rawName: string,
  options: GeneratorOptions = {},
  defaults: {
    readonly modulesDir?: string;
    readonly naming?: GeneratorNamingMode;
    readonly crud?: boolean;
    readonly includeRepository?: boolean;
    readonly includeSchema?: boolean;
    readonly includeController?: boolean;
  } = {},
): ResolvedGeneratorContext {
  const symbol = inflectSymbolName(rawName);
  const modulesDir = (options.modulesDir ?? defaults.modulesDir ?? 'src/modules').replace(
    /\/+$/,
    '',
  );
  const naming: GeneratorNamingMode = options.naming ?? defaults.naming ?? 'plural';
  const crud = options.crud ?? defaults.crud ?? true;
  const includeRepository = options.includeRepository ?? defaults.includeRepository ?? crud;
  const includeSchema = options.includeSchema ?? defaults.includeSchema ?? crud;
  const includeController = options.includeController ?? defaults.includeController ?? true;

  const filePrefix =
    naming === 'plural'
      ? symbol.pluralKebab
      : naming === 'singular'
        ? symbol.singularKebab
        : symbol.kebab;

  const modulePascal =
    naming === 'plural'
      ? symbol.pluralPascal
      : naming === 'singular'
        ? symbol.singularPascal
        : symbol.pascal;

  const moduleCamel =
    naming === 'plural'
      ? symbol.pluralCamel
      : naming === 'singular'
        ? symbol.singularCamel
        : symbol.camel;

  const entityPascal = symbol.singularPascal;
  const entityCamel = symbol.singularCamel;
  const routePath = `/${naming === 'exact' ? symbol.kebab : symbol.pluralKebab}`;
  const relativeDir = `${modulesDir}/${filePrefix}`;

  return {
    symbol,
    modulesDir,
    naming,
    filePrefix,
    relativeDir,
    modulePascal,
    moduleCamel,
    entityPascal,
    entityCamel,
    routePath,
    crud,
    includeRepository,
    includeSchema,
    includeController,
  };
}
