import { ValidationError } from '@forge-fr/core';
import { PathTraversalError } from './errors.js';

const DANGEROUS_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

export function isDangerousPropertyKey(key: string): boolean {
  return DANGEROUS_KEYS.has(key);
}

export interface SanitizeObjectOptions {
  /** Maximum object/array nesting depth to prevent stack exhaustion (default: 32). */
  readonly maxDepth?: number;
}

function sanitizeInternal(value: unknown, depth: number, maxDepth: number): unknown {
  if (depth > maxDepth) {
    throw new ValidationError(`Payload exceeds maximum allowed nesting depth of ${maxDepth}`);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeInternal(item, depth + 1, maxDepth));
  }

  const clean: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (isDangerousPropertyKey(key)) {
      continue;
    }
    clean[key] = sanitizeInternal((value as Record<string, unknown>)[key], depth + 1, maxDepth);
  }
  return clean;
}

/**
 * Recursively strips `__proto__`, `constructor`, and `prototype` keys into
 * null-prototype objects to neutralize prototype pollution payloads.
 */
export function sanitizeObject<T>(value: T, options: SanitizeObjectOptions = {}): T {
  const maxDepth = options.maxDepth ?? 32;
  return sanitizeInternal(value, 0, maxDepth) as T;
}

export function safeJsonParse<T = unknown>(
  raw: string,
  options: SanitizeObjectOptions = {},
): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw, (key, val: unknown) => {
      if (isDangerousPropertyKey(key)) {
        return undefined;
      }
      return val;
    });
  } catch {
    throw new ValidationError('Invalid JSON payload');
  }
  return sanitizeObject(parsed, options) as T;
}

const WINDOWS_RESERVED_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);

export interface SanitizeFilenameOptions {
  readonly maxLength?: number;
  readonly fallback?: string;
}

export function sanitizeFilename(
  raw: string,
  options: SanitizeFilenameOptions = {},
): string {
  const maxLength = options.maxLength ?? 128;
  const fallback = options.fallback ?? 'file';

  if (typeof raw !== 'string') {
    return fallback;
  }

  // Extract basename across both POSIX and Windows separators
  const segments = raw.split(/[\\/]+/).filter((seg) => seg.length > 0);
  let base = segments[segments.length - 1] ?? '';

  // Replace null bytes and control characters
  base = base.replace(/[\u0000-\u001f\u007f]/g, '_');
  // Strip unsafe filesystem characters
  base = base.replace(/[<>:"|?*]/g, '_');
  // Remove leading dots and whitespace to avoid hidden files or '.' / '..'
  base = base.trim().replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');

  if (base.length === 0) {
    return fallback;
  }

  const stem = base.split('.')[0]?.toUpperCase() ?? '';
  if (WINDOWS_RESERVED_NAMES.has(stem)) {
    base = `${fallback}_${base}`;
  }

  if (base.length > maxLength) {
    base = base.slice(0, maxLength);
  }

  return base;
}

function decodeRepeatedly(input: string, maxPasses = 4): string {
  let current = input;
  for (let i = 0; i < maxPasses; i += 1) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      throw new PathTraversalError('Malformed percent-encoding in file path');
    }
    if (next === current) {
      break;
    }
    current = next;
  }
  return current;
}

function normalizePosixRoot(rootDir: string): string {
  if (typeof rootDir !== 'string' || rootDir.trim().length === 0 || rootDir.includes('\u0000')) {
    throw new PathTraversalError('Invalid root directory');
  }
  const normalized = rootDir.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized.length === 0 ? '/' : normalized;
}

/**
 * Pure runtime-neutral canonical path confinement preventing directory traversal
 * (`../`, `%2e%2e`, double-encoding, backslashes, drive prefixes, null bytes, and sibling prefix bypasses).
 */
export function resolveConfinedPath(rootDir: string, untrustedPath: string): string {
  const root = normalizePosixRoot(rootDir);

  if (typeof untrustedPath !== 'string' || untrustedPath.length === 0) {
    throw new PathTraversalError('Path must be a non-empty string');
  }
  if (untrustedPath.includes('\u0000')) {
    throw new PathTraversalError('Null byte forbidden in path');
  }

  const decoded = decodeRepeatedly(untrustedPath);
  if (
    decoded.includes('\u0000') ||
    decoded.includes('\\') ||
    decoded.startsWith('/') ||
    /^[a-zA-Z]:/.test(decoded)
  ) {
    throw new PathTraversalError('Disallowed absolute, drive-prefixed, or backslash path');
  }

  const rawSegments = decoded.split('/');
  const resolvedSegments: string[] = [];

  for (const seg of rawSegments) {
    if (seg === '' || seg === '.') {
      continue;
    }
    if (seg === '..') {
      throw new PathTraversalError('Parent directory traversal is forbidden');
    }
    resolvedSegments.push(seg);
  }

  if (resolvedSegments.length === 0) {
    throw new PathTraversalError('Path resolves to root directory');
  }

  const prefix = root === '/' ? '/' : `${root}/`;
  const resolved = `${prefix}${resolvedSegments.join('/')}`;

  if (!resolved.startsWith(prefix)) {
    throw new PathTraversalError('Resolved path escapes confined root directory');
  }

  return resolved;
}
