import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import {
  loadConfig,
  readRuntimeEnv,
  type ConfigOutput,
  type LoadConfigOptions,
} from './define-config.js';
import { parseDotEnv, type ParseDotEnvOptions } from './dotenv.js';

export interface NodeDotEnvOptions extends ParseDotEnvOptions {
  /** Working directory for resolving relative `.env` filenames. Default: `process.cwd()`. */
  readonly cwd?: string;
  /** Explicit list of `.env` file paths in ascending precedence. */
  readonly files?: readonly string[];
  /** Node environment name (e.g. `development`, `test`, `production`) for `.env.<env>` layering. */
  readonly nodeEnv?: string;
  /** Whether `.env` values override existing keys in `baseEnv`. Default: `false` (env wins). */
  readonly override?: boolean;
}

function defaultDotEnvFiles(nodeEnv: string | undefined): string[] {
  const files = ['.env', '.env.local'];
  if (nodeEnv && nodeEnv.trim().length > 0) {
    const cleanEnv = nodeEnv.trim();
    files.push(`.env.${cleanEnv}`, `.env.${cleanEnv}.local`);
  }
  return files;
}

/**
 * Synchronously loads `.env` files from disk on Node.js / Bun in deterministic precedence order
 * (`.env` -> `.env.local` -> `.env.<NODE_ENV>` -> `.env.<NODE_ENV>.local`), merging with `baseEnv`.
 */
export function loadDotEnvFilesSync(options: NodeDotEnvOptions = {}): Record<string, string> {
  const cwd = options.cwd ?? process.cwd();
  const baseEnv = options.baseEnv ?? readRuntimeEnv();
  const nodeEnv = options.nodeEnv ?? baseEnv['NODE_ENV'];
  const fileList = options.files ?? defaultDotEnvFiles(nodeEnv);
  const merged: Record<string, string> = {};

  for (const relOrAbs of fileList) {
    const absPath = path.resolve(cwd, relOrAbs);
    if (!fs.existsSync(absPath)) {
      continue;
    }
    const content = fs.readFileSync(absPath, 'utf8');
    const parsed = parseDotEnv(content, {
      ...(options.expand !== undefined ? { expand: options.expand } : {}),
      baseEnv: { ...baseEnv, ...merged },
    });
    Object.assign(merged, parsed);
  }

  if (options.override !== true) {
    for (const [k, v] of Object.entries(baseEnv)) {
      if (v !== undefined) {
        merged[k] = v;
      }
    }
  }

  return merged;
}

/**
 * Asynchronously loads `.env` files from disk on Node.js / Bun in deterministic precedence order.
 */
export async function loadDotEnvFiles(
  options: NodeDotEnvOptions = {},
): Promise<Record<string, string>> {
  const cwd = options.cwd ?? process.cwd();
  const baseEnv = options.baseEnv ?? readRuntimeEnv();
  const nodeEnv = options.nodeEnv ?? baseEnv['NODE_ENV'];
  const fileList = options.files ?? defaultDotEnvFiles(nodeEnv);
  const merged: Record<string, string> = {};

  for (const relOrAbs of fileList) {
    const absPath = path.resolve(cwd, relOrAbs);
    let content: string;
    try {
      content = await fsPromises.readFile(absPath, 'utf8');
    } catch {
      continue;
    }
    const parsed = parseDotEnv(content, {
      ...(options.expand !== undefined ? { expand: options.expand } : {}),
      baseEnv: { ...baseEnv, ...merged },
    });
    Object.assign(merged, parsed);
  }

  if (options.override !== true) {
    for (const [k, v] of Object.entries(baseEnv)) {
      if (v !== undefined) {
        merged[k] = v;
      }
    }
  }

  return merged;
}

export interface LoadNodeConfigOptions<TSchema extends StandardSchemaV1>
  extends Omit<LoadConfigOptions<TSchema>, 'dotenvFiles' | 'fileReader'> {
  /** Load `.env` files from disk before validating. Pass `true` for default `.env` precedence or custom options. */
  readonly dotenv?: boolean | NodeDotEnvOptions;
}

/**
 * Node.js / Bun convenience loader that reads `.env` files from disk and validates the merged
 * environment against a Standard Schema v1 schema.
 */
export async function loadNodeConfig<TSchema extends StandardSchemaV1>(
  options: LoadNodeConfigOptions<TSchema>,
): Promise<ConfigOutput<TSchema>> {
  if (!options.dotenv) {
    return loadConfig(options);
  }

  const dotEnvOpts: NodeDotEnvOptions =
    typeof options.dotenv === 'object' ? options.dotenv : {};
  const fileEnv = await loadDotEnvFiles({
    ...dotEnvOpts,
    baseEnv: (options.env as Readonly<Record<string, string | undefined>> | undefined) ?? readRuntimeEnv(),
  });

  return loadConfig({
    ...options,
    env: fileEnv,
  });
}
