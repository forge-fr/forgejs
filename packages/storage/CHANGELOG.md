# Changelog

## 0.1.0 (2026-11-25)

- Initial release of `@forge-fr/storage`:
  - `StorageAdapter` contract with canonical key validation blocking multi-pass encoded traversal, NUL bytes, Windows drive paths/reserved names, and sibling prefix escapes.
  - MIME allowlisting, object size limits, and binary magic-byte header verification (`validateObjectUpload`).
  - Root-jailed `createLocalStorageAdapter()` blocking symlink escapes outside `rootDir`.
  - Zero-dependency Web Crypto AWS SigV4 `createS3StorageAdapter()` with presigned URL support, `SecretValue` credentials, and injectable `fetch`.
  - `createMemoryStorageAdapter()` and `createStoragePlugin()` / `StorageTokens`.

## [1.0.0] - 2026-11-27

### Added & Changed
- Synchronized `@forge-fr/storage` to `1.0.0` General Availability.

