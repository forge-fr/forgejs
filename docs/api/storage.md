# @forge-fr/storage

> Object storage adapters for Memory, symlink-jailed local disk, and zero-SDK Web Crypto AWS SigV4 S3 with MIME allowlists, binary magic-byte inspection, and presigned URLs.

- **Version**: v1.0.0-rc.2
- **Layer**: Infrastructure
- **Category**: infrastructure
- **Tarball**: 22.5 kB (36 files)
- **Internal deps**: @forge-fr/core
- **Runtime deps**: zero runtime dependencies
- **Peer deps**: none
- **HTML URL**: https://github.com/forge-fr/forgejs/api/storage
- **Markdown URL**: https://github.com/forge-fr/forgejs/api/storage.md

## Installation

```bash
npm install @forge-fr/storage
```

## Plugin Metadata

- **Factory**: `createStoragePlugin`
- **Tokens**: `StorageTokens`
- **Health probe**: `storage`
- **Capabilities**: `di:register`, `health:register`

## Runtime & Error Semantics

- **Runtime**: Zero third-party runtime dependencies. S3 adapter signs AWS SigV4 requests via Web Crypto with HTTPS enforced by default.
- **Errors**: Local storage enforces canonical symlink confinement (StoragePathError) and optional MIME allowlist + magic-byte checks (StorageValidationError).

## Usage Example

```ts
import { createMemoryStorageAdapter } from '@forge-fr/storage';

const storage = createMemoryStorageAdapter();
await storage.put('avatars/u42.txt', new TextEncoder().encode('hello'), {
  contentType: 'text/plain',
});
```

## Public Exports

### Storage Adapters, Validation & Plugin

- **Values**: `StorageError`, `StorageObjectNotFoundError`, `StoragePathError`, `StorageValidationError`, `canonicalizeStorageKey`, `computeSha256Hex`, `createStorageObject`, `sanitizeUserMetadata`, `toArrayBufferCopy`, `toUint8Array`, `validateObjectUpload`, `verifyMagicBytesForMime`, `createMemoryStorageAdapter`, `createLocalStorageAdapter`, `createS3StorageAdapter`, `StorageTokens`, `createStoragePlugin`
- **Types**: `LocalStorageOptions`, `MemoryStorageOptions`, `S3StorageOptions`, `StorageAdapter`, `StorageDriver`, `StorageListOptions`, `StorageListResult`, `StorageObject`, `StorageObjectMetadata`, `StoragePluginOptions`, `StoragePutOptions`, `StorageSignedUrlOptions`, `StorageUploadData`, `StorageValidationConfig`
