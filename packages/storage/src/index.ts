export {
  StorageError,
  StorageObjectNotFoundError,
  StoragePathError,
  StorageValidationError,
} from './errors.js';

export {
  canonicalizeStorageKey,
  computeSha256Hex,
  createStorageObject,
  sanitizeUserMetadata,
  toArrayBufferCopy,
  toUint8Array,
  validateObjectUpload,
  verifyMagicBytesForMime,
} from './validation.js';

export { createMemoryStorageAdapter } from './memory.js';
export { createLocalStorageAdapter } from './local.js';
export { createS3StorageAdapter } from './s3.js';
export { StorageTokens, createStoragePlugin, type StoragePluginOptions } from './plugin.js';

export type {
  LocalStorageOptions,
  MemoryStorageOptions,
  S3StorageOptions,
  StorageAdapter,
  StorageDriver,
  StorageListOptions,
  StorageListResult,
  StorageObject,
  StorageObjectMetadata,
  StoragePutOptions,
  StorageSignedUrlOptions,
  StorageUploadData,
  StorageValidationConfig,
} from './types.js';
