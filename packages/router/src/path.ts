import { RouterError, type ParamConstraint } from './types.js';

const FORBIDDEN_PARAM_NAMES: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

export type ParsedSegment =
  | { readonly kind: 'static'; readonly value: string }
  | {
      readonly kind: 'constrained';
      readonly paramName: string;
      readonly key: string;
      readonly test: (value: string) => boolean;
    }
  | { readonly kind: 'param'; readonly paramName: string }
  | { readonly kind: 'wildcard'; readonly paramName: string };

export interface ParsedRoutePath {
  readonly normalizedPath: string;
  readonly segments: readonly ParsedSegment[];
  readonly paramNames: readonly string[];
  readonly signature: string;
}

export function stripQueryAndHash(rawPath: string): string {
  const qIdx = rawPath.indexOf('?');
  const hIdx = rawPath.indexOf('#');
  if (qIdx === -1 && hIdx === -1) {
    return rawPath;
  }
  let end = rawPath.length;
  if (qIdx !== -1 && qIdx < end) end = qIdx;
  if (hIdx !== -1 && hIdx < end) end = hIdx;
  return rawPath.slice(0, end);
}

export function joinRoutePaths(prefix: string, subPath: string): string {
  const cleanPrefix = prefix.trim();
  const cleanSub = subPath.trim();

  if (cleanPrefix.length === 0) {
    return cleanSub.startsWith('/') ? cleanSub : `/${cleanSub}`;
  }

  const left = cleanPrefix.endsWith('/') ? cleanPrefix.slice(0, -1) : cleanPrefix;
  if (cleanSub === '' || cleanSub === '/') {
    return left.length === 0 ? '/' : left.startsWith('/') ? left : `/${left}`;
  }

  const right = cleanSub.startsWith('/') ? cleanSub : `/${cleanSub}`;
  const combined = `${left}${right}`;
  return combined.startsWith('/') ? combined : `/${combined}`;
}

export function normalizePathname(rawPath: string, ignoreTrailingSlash: boolean): string {
  const len = rawPath.length;
  if (len === 0 || rawPath === '/') {
    return '/';
  }
  if (
    rawPath.charCodeAt(0) === 47 &&
    (!ignoreTrailingSlash || rawPath.charCodeAt(len - 1) !== 47) &&
    rawPath.indexOf('?') === -1 &&
    rawPath.indexOf('#') === -1 &&
    rawPath.indexOf('//') === -1
  ) {
    return rawPath;
  }

  const stripped = stripQueryAndHash(rawPath);
  if (stripped.length === 0 || stripped === '/') {
    return '/';
  }

  const collapsed = stripped.indexOf('//') !== -1 ? stripped.replace(/\/{2,}/g, '/') : stripped;
  const withLeading = collapsed.charCodeAt(0) === 47 ? collapsed : `/${collapsed}`;

  if (ignoreTrailingSlash && withLeading.length > 1 && withLeading.charCodeAt(withLeading.length - 1) === 47) {
    return withLeading.slice(0, -1);
  }
  return withLeading;
}

export function splitNormalizedPath(pathname: string): readonly string[] {
  if (pathname === '/') {
    return [];
  }
  // Remove leading slash; preserve trailing empty segment if ignoreTrailingSlash === false
  return pathname.slice(1).split('/');
}

export function safeDecodeSegment(segment: string): string | undefined {
  if (!segment.includes('%')) {
    return segment;
  }
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

export function safeDecodeWildcard(segments: readonly string[]): string | undefined {
  const decoded: string[] = [];
  for (const seg of segments) {
    const val = safeDecodeSegment(seg);
    if (val === undefined) {
      return undefined;
    }
    decoded.push(val);
  }
  return decoded.join('/');
}

function validateParamName(name: string, fullPath: string): void {
  if (name.length === 0) {
    throw new RouterError('INVALID_PARAM_NAME', `Empty parameter name in route "${fullPath}"`);
  }
  if (FORBIDDEN_PARAM_NAMES.has(name)) {
    throw new RouterError(
      'INVALID_PARAM_NAME',
      `Forbidden parameter name "${name}" in route "${fullPath}"`,
    );
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new RouterError(
      'INVALID_PARAM_NAME',
      `Invalid parameter name "${name}" in route "${fullPath}"`,
    );
  }
}

function compileRegexConstraint(pattern: string, fullPath: string): (value: string) => boolean {
  try {
    const anchored = new RegExp(`^(?:${pattern})$`);
    return (value: string) => anchored.test(value);
  } catch {
    throw new RouterError(
      'INVALID_CONSTRAINT',
      `Invalid regex constraint "{${pattern}}" in route "${fullPath}"`,
    );
  }
}

function wrapConstraint(
  constraint: ParamConstraint,
  fullPath: string,
): { key: string; test: (value: string) => boolean } {
  if (typeof constraint === 'function') {
    return {
      key: `fn:${constraint.name || 'anonymous'}:${constraint.toString()}`,
      test: constraint,
    };
  }
  if (constraint instanceof RegExp) {
    // Strip global/sticky flags to prevent stateful lastIndex bugs across requests
    const safeFlags = constraint.flags.replace(/[gy]/g, '');
    const compiled = new RegExp(`^(?:${constraint.source})$`, safeFlags);
    return {
      key: `re:/${constraint.source}/${safeFlags}`,
      test: (value: string) => compiled.test(value),
    };
  }
  throw new RouterError(
    'INVALID_CONSTRAINT',
    `Unsupported parameter constraint in route "${fullPath}"`,
  );
}

export function parseRoutePath(
  rawPath: string,
  ignoreTrailingSlash: boolean,
  constraints?: Readonly<Record<string, ParamConstraint>>,
): ParsedRoutePath {
  if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
    throw new RouterError('INVALID_ROUTE', 'Route path must be a non-empty string');
  }

  const normalizedPath = normalizePathname(rawPath, ignoreTrailingSlash);
  const rawSegments = splitNormalizedPath(normalizedPath);
  const segments: ParsedSegment[] = [];
  const paramNames: string[] = [];
  const seenParams = new Set<string>();
  const sigParts: string[] = [];

  for (let i = 0; i < rawSegments.length; i += 1) {
    const part = rawSegments[i] ?? '';

    if (part.startsWith('*')) {
      if (i !== rawSegments.length - 1) {
        throw new RouterError(
          'INVALID_ROUTE',
          `Wildcard segment "${part}" must be the final segment in route "${normalizedPath}"`,
        );
      }
      const paramName = part.length === 1 ? '*' : part.slice(1);
      if (paramName !== '*') {
        validateParamName(paramName, normalizedPath);
      }
      if (seenParams.has(paramName)) {
        throw new RouterError(
          'INVALID_PARAM_NAME',
          `Duplicate parameter name "${paramName}" in route "${normalizedPath}"`,
        );
      }
      seenParams.add(paramName);
      paramNames.push(paramName);
      segments.push({ kind: 'wildcard', paramName });
      sigParts.push('*');
      continue;
    }

    if (part.startsWith(':')) {
      const braceStart = part.indexOf('{');
      let paramName: string;
      let inlinePattern: string | undefined;

      if (braceStart !== -1) {
        if (!part.endsWith('}') || braceStart <= 1) {
          throw new RouterError(
            'INVALID_CONSTRAINT',
            `Malformed constrained parameter "${part}" in route "${normalizedPath}"`,
          );
        }
        paramName = part.slice(1, braceStart);
        inlinePattern = part.slice(braceStart + 1, -1);
        if (inlinePattern.length === 0) {
          throw new RouterError(
            'INVALID_CONSTRAINT',
            `Empty regex constraint in segment "${part}" of route "${normalizedPath}"`,
          );
        }
      } else {
        paramName = part.slice(1);
      }

      validateParamName(paramName, normalizedPath);
      if (seenParams.has(paramName)) {
        throw new RouterError(
          'INVALID_PARAM_NAME',
          `Duplicate parameter name "${paramName}" in route "${normalizedPath}"`,
        );
      }
      seenParams.add(paramName);
      paramNames.push(paramName);

      const externalConstraint = constraints?.[paramName];
      if (inlinePattern !== undefined && externalConstraint !== undefined) {
        throw new RouterError(
          'INVALID_CONSTRAINT',
          `Parameter "${paramName}" cannot specify both inline regex and options.constraints in route "${normalizedPath}"`,
        );
      }

      if (inlinePattern !== undefined) {
        const test = compileRegexConstraint(inlinePattern, normalizedPath);
        const key = `inline:${inlinePattern}`;
        segments.push({ kind: 'constrained', paramName, key, test });
        sigParts.push(`:{${key}}`);
      } else if (externalConstraint !== undefined) {
        const wrapped = wrapConstraint(externalConstraint, normalizedPath);
        segments.push({
          kind: 'constrained',
          paramName,
          key: wrapped.key,
          test: wrapped.test,
        });
        sigParts.push(`:{${wrapped.key}}`);
      } else {
        segments.push({ kind: 'param', paramName });
        sigParts.push(':');
      }
      continue;
    }

    segments.push({ kind: 'static', value: part });
    sigParts.push(`s:${part}`);
  }

  return {
    normalizedPath,
    segments,
    paramNames,
    signature: `/${sigParts.join('/')}`,
  };
}
