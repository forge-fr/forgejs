import fs from 'node:fs/promises';
import path from 'node:path';
import {
  StorageError,
  StorageObjectNotFoundError,
  StoragePathError,
} from './errors.js';
import type {
  LocalStorageOptions,
  StorageAdapter,
  StorageListOptions,
  StorageListResult,
  StorageObject,
  StorageObjectMetadata,
  StoragePutOptions,
  StorageUploadData,
} from './types.js';
import {
  canonicalizeStorageKey,
  computeSha256Hex,
  createStorageObject,
  sanitizeUserMetadata,
  validateObjectUpload,
} from './validation.js';

const META_SUFFIX = '.forge-meta.json';

interface PersistedMetaFile {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  readonly contentType: string;
  readonly lastModified: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

function isInsideRoot(candidateReal: string, rootReal: string): boolean {
  if (candidateReal === rootReal) {
    return true;
  }
  const normalizedRoot = rootReal.endsWith(path.sep) ? rootReal : `${rootReal}${path.sep}`;
  return candidateReal.startsWith(normalizedRoot);
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}

export function createLocalStorageAdapter(options: LocalStorageOptions): StorageAdapter {
  let rootRealPath: string | undefined;
  let connected = false;

  async function ensureRootRealPath(): Promise<string> {
    if (rootRealPath !== undefined) {
      return rootRealPath;
    }
    await fs.mkdir(options.rootDir, { recursive: true });
    const resolved = await fs.realpath(options.rootDir);
    rootRealPath = resolved;
    return resolved;
  }

  /**
   * Walks every path segment starting at `rootReal`, rejecting symlinks that point outside
   * `rootDir` BEFORE any directory creation, read, or write occurs.
   */
  async function resolveJailedPath(canonicalKey: string): Promise<{
    readonly objectPath: string;
    readonly metaPath: string;
    readonly rootReal: string;
  }> {
    if (canonicalKey.endsWith(META_SUFFIX)) {
      throw new StoragePathError('Reserved sidecar metadata suffix cannot be used as an object key');
    }

    const rootReal = await ensureRootRealPath();
    const segments = canonicalKey.split('/');
    let currentDir = rootReal;

    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i]!;
      const candidate = path.join(currentDir, seg);
      try {
        const lstat = await fs.lstat(candidate);
        if (lstat.isSymbolicLink()) {
          let resolvedTarget: string;
          try {
            resolvedTarget = await fs.realpath(candidate);
          } catch {
            throw new StoragePathError(
              `Symlink segment "${seg}" could not be resolved safely inside storage root`,
            );
          }
          if (!isInsideRoot(resolvedTarget, rootReal)) {
            throw new StoragePathError(
              `Symlink traversal outside storage root rejected for key "${canonicalKey}"`,
            );
          }
          currentDir = resolvedTarget;
        } else {
          const resolvedNode = await fs.realpath(candidate);
          if (!isInsideRoot(resolvedNode, rootReal)) {
            throw new StoragePathError(`Path resolves outside storage root for "${canonicalKey}"`);
          }
          currentDir = resolvedNode;
        }
      } catch (err: unknown) {
        if (isEnoent(err)) {
          // Once we hit the first non-existent segment, build the remaining path lexically from verified `currentDir`
          const remaining = segments.slice(i);
          const safeObjectPath = path.join(currentDir, ...remaining);
          if (!isInsideRoot(safeObjectPath, rootReal)) {
            throw new StoragePathError(`Path escapes storage root for "${canonicalKey}"`);
          }
          return {
            objectPath: safeObjectPath,
            metaPath: `${safeObjectPath}${META_SUFFIX}`,
            rootReal,
          };
        }
        throw err;
      }
    }

    if (!isInsideRoot(currentDir, rootReal)) {
      throw new StoragePathError(`Target escapes storage root for "${canonicalKey}"`);
    }
    return {
      objectPath: currentDir,
      metaPath: `${currentDir}${META_SUFFIX}`,
      rootReal,
    };
  }

  async function readSidecarOrStat(
    canonicalKey: string,
    objectPath: string,
    metaPath: string,
  ): Promise<StorageObjectMetadata | undefined> {
    let fileStat;
    try {
      fileStat = await fs.lstat(objectPath);
    } catch (err: unknown) {
      if (isEnoent(err)) {
        return undefined;
      }
      throw err;
    }

    if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
      throw new StoragePathError(`Storage target "${canonicalKey}" is not a safe regular file`);
    }

    try {
      const rawMeta = await fs.readFile(metaPath, 'utf8');
      const parsed = JSON.parse(rawMeta) as PersistedMetaFile;
      const sanitizedMeta = sanitizeUserMetadata(parsed.metadata);
      return {
        key: canonicalKey,
        size: parsed.size,
        etag: parsed.etag,
        contentType: parsed.contentType,
        lastModified: new Date(parsed.lastModified),
        ...(sanitizedMeta !== undefined ? { metadata: sanitizedMeta } : {}),
      };
    } catch {
      const rawBytes = await fs.readFile(objectPath);
      const etag = await computeSha256Hex(rawBytes);
      return {
        key: canonicalKey,
        size: fileStat.size,
        etag,
        contentType: 'application/octet-stream',
        lastModified: fileStat.mtime,
      };
    }
  }

  return {
    driver: 'local',

    async connect(): Promise<void> {
      await ensureRootRealPath();
      connected = true;
    },

    async disconnect(): Promise<void> {
      connected = false;
    },

    async ping(): Promise<boolean> {
      if (!connected) {
        return false;
      }
      try {
        const root = await ensureRootRealPath();
        await fs.access(root);
        return true;
      } catch {
        return false;
      }
    },

    async put(
      key: string,
      data: StorageUploadData,
      putOptions?: StoragePutOptions,
    ): Promise<StorageObjectMetadata> {
      const validated = await validateObjectUpload(key, data, putOptions, options);
      const { objectPath, metaPath, rootReal } = await resolveJailedPath(validated.key);

      await fs.mkdir(path.dirname(objectPath), { recursive: true });
      const parentReal = await fs.realpath(path.dirname(objectPath));
      if (!isInsideRoot(parentReal, rootReal)) {
        throw new StoragePathError(`Resolved parent directory escapes storage root`);
      }

      await fs.writeFile(objectPath, validated.bytes);
      const etag = await computeSha256Hex(validated.bytes);
      const lastModified = new Date();

      const metadata: StorageObjectMetadata = {
        key: validated.key,
        size: validated.bytes.byteLength,
        etag,
        contentType: validated.contentType,
        lastModified,
        ...(validated.metadata !== undefined ? { metadata: validated.metadata } : {}),
      };

      const persisted: PersistedMetaFile = {
        key: metadata.key,
        size: metadata.size,
        etag: metadata.etag,
        contentType: metadata.contentType,
        lastModified: lastModified.toISOString(),
        ...(metadata.metadata !== undefined ? { metadata: metadata.metadata } : {}),
      };

      await fs.writeFile(metaPath, JSON.stringify(persisted), 'utf8');
      return metadata;
    },

    async get(key: string): Promise<StorageObject> {
      const canonical = canonicalizeStorageKey(key);
      const { objectPath, metaPath } = await resolveJailedPath(canonical);
      const metadata = await readSidecarOrStat(canonical, objectPath, metaPath);
      if (!metadata) {
        throw new StorageObjectNotFoundError(canonical);
      }
      const buffer = await fs.readFile(objectPath);
      return createStorageObject(metadata, new Uint8Array(buffer));
    },

    async head(key: string): Promise<StorageObjectMetadata | undefined> {
      const canonical = canonicalizeStorageKey(key);
      const { objectPath, metaPath } = await resolveJailedPath(canonical);
      return readSidecarOrStat(canonical, objectPath, metaPath);
    },

    async exists(key: string): Promise<boolean> {
      return (await this.head(key)) !== undefined;
    },

    async delete(key: string): Promise<boolean> {
      const canonical = canonicalizeStorageKey(key);
      const { objectPath, metaPath } = await resolveJailedPath(canonical);
      let deleted = false;
      try {
        await fs.unlink(objectPath);
        deleted = true;
      } catch (err: unknown) {
        if (!isEnoent(err)) {
          throw new StorageError(`Failed to delete storage object "${canonical}"`, { cause: err });
        }
      }
      try {
        await fs.unlink(metaPath);
      } catch {
        // Sidecar optional
      }
      return deleted;
    },

    async list(listOptions: StorageListOptions = {}): Promise<StorageListResult> {
      const rootReal = await ensureRootRealPath();
      const prefix = listOptions.prefix ?? '';
      const limit = listOptions.limit ?? 1000;
      const offset = listOptions.cursor ? Number.parseInt(listOptions.cursor, 10) : 0;

      const collected: StorageObjectMetadata[] = [];

      async function walk(dirPath: string, relPrefix: string): Promise<void> {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isSymbolicLink()) {
            // Skip any symlinks inside bucket during directory enumeration
            continue;
          }
          const full = path.join(dirPath, entry.name);
          const relKey = relPrefix.length > 0 ? `${relPrefix}/${entry.name}` : entry.name;

          if (entry.isDirectory()) {
            const realDir = await fs.realpath(full);
            if (isInsideRoot(realDir, rootReal)) {
              await walk(full, relKey);
            }
          } else if (entry.isFile() && !entry.name.endsWith(META_SUFFIX)) {
            if (prefix.length === 0 || relKey.startsWith(prefix)) {
              const meta = await readSidecarOrStat(relKey, full, `${full}${META_SUFFIX}`);
              if (meta) {
                collected.push(meta);
              }
            }
          }
        }
      }

      await walk(rootReal, '');
      collected.sort((a, b) => a.key.localeCompare(b.key));

      const page = collected.slice(offset, offset + limit);
      const nextOffset = offset + page.length;
      const nextCursor = nextOffset < collected.length ? String(nextOffset) : undefined;
      return {
        objects: page,
        ...(nextCursor !== undefined ? { nextCursor } : {}),
      };
    },
  };
}
