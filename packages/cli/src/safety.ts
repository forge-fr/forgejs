import path from 'node:path';
import { CliError } from './errors.js';
import type { NormalizedSymbolName } from './types.js';

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const PROJECT_NAME_REGEX = /^[a-z][a-z0-9-]{0,62}$/;
const SYMBOL_NAME_REGEX = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const PACKAGE_NAME_REGEX = /^(?:@[a-z0-9][a-z0-9._-]{0,60}\/)?[a-z0-9][a-z0-9._-]{0,60}$/;

export const OFFICIAL_FORGE_PLUGINS: Readonly<Record<string, string>> = {
  auth: '@forge-fr/auth',
  authorization: '@forge-fr/authorization',
  bun: '@forge-fr/bun',
  cache: '@forge-fr/cache',
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

  const kebab = segments.join('-');
  const pascal = segments.map((s) => `${s[0]!.toUpperCase()}${s.slice(1)}`).join('');
  const camel = `${pascal[0]!.toLowerCase()}${pascal.slice(1)}`;

  return { kebab, pascal, camel };
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
      versionRange: '^1.0.0-rc.1',
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
