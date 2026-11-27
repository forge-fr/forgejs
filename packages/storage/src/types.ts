import type { SecretValue } from '@forge-fr/core';

export type StorageDriver = 'memory' | 'local' | 's3';

export type StorageUploadData =
  | Uint8Array
  | ArrayBuffer
  | string
  | ReadableStream<Uint8Array>;

export interface StoragePutOptions {
  readonly contentType?: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly cacheControl?: string;
}

export interface StorageObjectMetadata {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  readonly contentType: string;
  readonly lastModified: Date;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface StorageObject {
  readonly metadata: StorageObjectMetadata;
  arrayBuffer(): Promise<ArrayBuffer>;
  bytes(): Promise<Uint8Array>;
  text(): Promise<string>;
  stream(): ReadableStream<Uint8Array>;
}

export interface StorageListOptions {
  readonly prefix?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface StorageListResult {
  readonly objects: readonly StorageObjectMetadata[];
  readonly nextCursor?: string;
}

export interface StorageSignedUrlOptions {
  readonly expiresInSeconds?: number;
  readonly method?: 'GET' | 'PUT';
}

export interface StorageValidationConfig {
  /** Optional allowlist of MIME media types (lowercase, e.g. `['image/png', 'application/json']`). */
  readonly allowedMimeTypes?: readonly string[];
  /** Verify binary magic bytes match declared content type (blocks spoofed HTML/scripts). Default: `false`. */
  readonly verifyMagicBytes?: boolean;
  /** Maximum uploaded object size in bytes. */
  readonly maxObjectBytes?: number;
}

export interface StorageAdapter {
  readonly driver: StorageDriver;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  ping(): Promise<boolean>;
  put(
    key: string,
    data: StorageUploadData,
    options?: StoragePutOptions,
  ): Promise<StorageObjectMetadata>;
  get(key: string): Promise<StorageObject>;
  head(key: string): Promise<StorageObjectMetadata | undefined>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<boolean>;
  list(options?: StorageListOptions): Promise<StorageListResult>;
  getSignedUrl?(key: string, options?: StorageSignedUrlOptions): Promise<string>;
}

export interface MemoryStorageOptions extends StorageValidationConfig {
  /** Secret key material used for HMAC signed URLs in tests/dev. */
  readonly signingKey?: string | SecretValue<string>;
}

export interface LocalStorageOptions extends StorageValidationConfig {
  /** Root directory acting as strict jail for all stored objects. */
  readonly rootDir: string;
}

export interface S3StorageOptions extends StorageValidationConfig {
  readonly bucket: string;
  readonly region: string;
  /** Optional S3-compatible endpoint (e.g. R2, MinIO). Must use `https://` unless `allowInsecureHttp: true`. */
  readonly endpoint?: string;
  /** Use path-style URLs (`endpoint/bucket/key`) instead of virtual-hosted bucket subdomains. */
  readonly forcePathStyle?: boolean;
  readonly accessKeyId: string | SecretValue<string>;
  readonly secretAccessKey: string | SecretValue<string>;
  readonly sessionToken?: string | SecretValue<string>;
  /** Opt in to plain `http://` endpoints only for local development/testing. Default: `false`. */
  readonly allowInsecureHttp?: boolean;
  /** Optional custom fetch implementation. Default: `globalThis.fetch`. */
  readonly fetch?: typeof fetch;
}
