import path from 'node:path';
import { CliError } from './errors.js';
import type { InflectedSymbolName, NormalizedSymbolName } from './types.js';

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const PROJECT_NAME_REGEX = /^[a-z][a-z0-9-]{0,62}$/;
const SYMBOL_NAME_REGEX = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const PACKAGE_NAME_REGEX = /^(?:@[a-z0-9][a-z0-9._-]{0,60}\/)?[a-z0-9][a-z0-9._-]{0,60}$/;

const UNCOUNTABLE_WORDS = new Set([
  'analytics',
  'auth',
  'data',
  'equipment',
  'feedback',
  'fish',
  'health',
  'information',
  'media',
  'metadata',
  'money',
  'news',
  'research',
  'rice',
  'series',
  'sheep',
  'software',
  'species',
  'staff',
  'traffic',
]);

const IRREGULAR_SINGULAR_TO_PLURAL: Readonly<Record<string, string>> = {
  child: 'children',
  criterion: 'criteria',
  index: 'indices',
  man: 'men',
  matrix: 'matrices',
  mouse: 'mice',
  person: 'people',
  quiz: 'quizzes',
  vertex: 'vertices',
  woman: 'women',
};

const IRREGULAR_PLURAL_TO_SINGULAR: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(IRREGULAR_SINGULAR_TO_PLURAL).map(([s, p]) => [p, s]),
);

export function singularizeWord(rawWord: string): string {
  const word = rawWord.toLowerCase();
  if (!word || UNCOUNTABLE_WORDS.has(word)) {
    return word;
  }
  const irregular = IRREGULAR_PLURAL_TO_SINGULAR[word];
  if (irregular) {
    return irregular;
  }
  if (IRREGULAR_SINGULAR_TO_PLURAL[word]) {
    return word;
  }
  if (word.endsWith('ies') && word.length > 3 && !/[aeiou]ies$/.test(word)) {
    return `${word.slice(0, -3)}y`;
  }
  if (word.endsWith('ves') && word.length > 3) {
    const stem = word.slice(0, -3);
    if (stem.endsWith('kni') || stem.endsWith('wi') || stem.endsWith('li')) {
      return `${stem}fe`;
    }
    return `${stem}f`;
  }
  if (/(?:ses|xes|zes|ches|shes)$/.test(word) && word.length > 3) {
    return word.slice(0, -2);
  }
  if (word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us') && !word.endsWith('is') && word.length > 1) {
    return word.slice(0, -1);
  }
  return word;
}

export function pluralizeWord(rawWord: string): string {
  const word = rawWord.toLowerCase();
  if (!word || UNCOUNTABLE_WORDS.has(word)) {
    return word;
  }
  if (IRREGULAR_PLURAL_TO_SINGULAR[word]) {
    return word;
  }
  const irregular = IRREGULAR_SINGULAR_TO_PLURAL[word];
  if (irregular) {
    return irregular;
  }
  // If singularizeWord produces a strictly shorter root, the word is already plural
  const singularCandidate = singularizeWord(word);
  if (singularCandidate !== word) {
    return word;
  }
  if (word.endsWith('y') && word.length > 1 && !/[aeiou]y$/.test(word)) {
    return `${word.slice(0, -1)}ies`;
  }
  if (/(?:s|x|z|ch|sh)$/.test(word)) {
    return `${word}es`;
  }
  return `${word}s`;
}

function segmentsToNormalized(segments: readonly string[]): NormalizedSymbolName {
  const kebab = segments.join('-');
  const pascal = segments.map((s) => `${s[0]!.toUpperCase()}${s.slice(1)}`).join('');
  const camel = `${pascal[0]!.toLowerCase()}${pascal.slice(1)}`;
  return { kebab, pascal, camel };
}

export const OFFICIAL_FORGE_PLUGINS: Readonly<Record<string, string>> = {
  auth: '@forge-fr/auth',
  authorization: '@forge-fr/authorization',
  bun: '@forge-fr/bun',
  cache: '@forge-fr/cache',
  config: '@forge-fr/config',
  core: '@forge-fr/core',
  database: '@forge-fr/database',
  drizzle: '@forge-fr/drizzle',
  edge: '@forge-fr/edge',
  http: '@forge-fr/http',
  logger: '@forge-fr/logger',
  node: '@forge-fr/node',
  openapi: '@forge-fr/openapi',
  prisma: '@forge-fr/prisma',
  queue: '@forge-fr/queue',
  router: '@forge-fr/router',
  security: '@forge-fr/security',
  storage: '@forge-fr/storage',
  testing: '@forge-fr/testing',
  validation: '@forge-fr/validation',
};

export function validateProjectName(rawName: string): string {
  const trimmed = rawName.trim();
  if (!trimmed || DANGEROUS_KEYS.has(trimmed)) {
    throw new CliError('CLI_INVALID_ARGUMENT', `Invalid project name "${rawName}"`);
  }
  if (!PROJECT_NAME_REGEX.test(trimmed)) {
    throw new CliError(
      'CLI_INVALID_ARGUMENT',
      `Project name "${rawName}" must be lowercase kebab-case starting with a letter (e.g. my-forge-api)`,
    );
  }
  return trimmed;
}

export function validateSymbolName(rawName: string): NormalizedSymbolName {
  const trimmed = rawName.trim();
  if (!trimmed || DANGEROUS_KEYS.has(trimmed) || !SYMBOL_NAME_REGEX.test(trimmed)) {
    throw new CliError(
      'CLI_INVALID_ARGUMENT',
      `Invalid generator symbol "${rawName}". Use alphanumeric words separated by hyphens or underscores.`,
    );
  }

  const withWordBoundaries = trimmed
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/_/g, '-')
    .toLowerCase();
  const segments = withWordBoundaries.split('-').filter((s) => s.length > 0);
  if (segments.length === 0) {
    throw new CliError('CLI_INVALID_ARGUMENT', `Invalid generator symbol "${rawName}"`);
  }

  return segmentsToNormalized(segments);
}

export function inflectSymbolName(rawName: string): InflectedSymbolName {
  const exact = validateSymbolName(rawName);
  const segments = exact.kebab.split('-');
  const head = segments.slice(0, -1);
  const last = segments[segments.length - 1]!;

  const singularSegments = [...head, singularizeWord(last)];
  const pluralSegments = [...head, pluralizeWord(last)];

  const singular = segmentsToNormalized(singularSegments);
  const plural = segmentsToNormalized(pluralSegments);

  return {
    ...exact,
    singularKebab: singular.kebab,
    singularPascal: singular.pascal,
    singularCamel: singular.camel,
    pluralKebab: plural.kebab,
    pluralPascal: plural.pascal,
    pluralCamel: plural.camel,
  };
}

export function resolvePluginPackageSpec(rawPlugin: string): {
  readonly packageName: string;
  readonly versionRange: string;
  readonly isOfficial: boolean;
} {
  const trimmed = rawPlugin.trim();
  if (!trimmed || DANGEROUS_KEYS.has(trimmed)) {
    throw new CliError('CLI_INVALID_ARGUMENT', `Invalid plugin specifier "${rawPlugin}"`);
  }

  const normalizedShort = trimmed.startsWith('@forge-fr/')
    ? trimmed.slice('@forge-fr/'.length)
    : trimmed;
  const official = OFFICIAL_FORGE_PLUGINS[normalizedShort];
  if (official) {
    return {
      packageName: official,
      versionRange: '^1.0.0',
      isOfficial: true,
    };
  }

  if (trimmed.startsWith('@forge-fr/') || !PACKAGE_NAME_REGEX.test(trimmed)) {
    throw new CliError(
      'CLI_INVALID_ARGUMENT',
      `Unknown or invalid plugin specifier "${rawPlugin}". Supported ForgeJS plugins: ${Object.keys(OFFICIAL_FORGE_PLUGINS).join(', ')}`,
    );
  }

  return {
    packageName: trimmed,
    versionRange: 'latest',
    isOfficial: false,
  };
}

export function resolveSafeTargetPath(baseDir: string, relativeTarget: string): string {
  if (!relativeTarget || relativeTarget.includes('\0') || path.isAbsolute(relativeTarget)) {
    throw new CliError(
      'CLI_PATH_VIOLATION',
      `Target path "${relativeTarget}" must be relative within "${baseDir}"`,
    );
  }
  const normalizedSegments = relativeTarget.split(/[\\/]+/);
  for (const seg of normalizedSegments) {
    if (seg === '..' || DANGEROUS_KEYS.has(seg)) {
      throw new CliError(
        'CLI_PATH_VIOLATION',
        `Path traversal segment blocked in "${relativeTarget}"`,
      );
    }
  }

  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, ...normalizedSegments);
  const rel = path.relative(resolvedBase, resolvedTarget);

  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new CliError(
      'CLI_PATH_VIOLATION',
      `Resolved target "${resolvedTarget}" escapes base directory "${resolvedBase}"`,
    );
  }
  return resolvedTarget;
}

export function sanitizeJsonObject<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (DANGEROUS_KEYS.has(key)) {
      continue;
    }
    safe[key] = value;
  }
  return safe;
}
