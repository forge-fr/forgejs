# File Storage & S3

> Memory, symlink-jailed local disk, and zero-SDK Web Crypto AWS SigV4 S3 object storage with magic-byte upload validation.

- **Section**: Advanced Features
- **Packages**: @forge-fr/storage
- **Version**: v1.0.0-rc.2
- **Updated**: 2026-11-26
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/advanced/storage
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/advanced/storage.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/infrastructure-and-cli.md

## Traversal-safe keys, symlink confinement & AWS SigV4

- All storage adapters normalize keys and reject path traversal (../, null bytes, absolute paths) with StoragePathError.
- createLocalStorageAdapter() jails writes inside the configured root using canonical realpath symlink verification.
- createS3StorageAdapter() signs AWS SigV4 requests via Web Crypto with zero AWS SDK dependencies and HTTPS enforced by default.
- verifyMagicBytesForMime() validates actual file binary headers against allowed MIME types.

**File: `src/storage.ts`**

```ts
import assert from 'node:assert/strict';
import {
  createMemoryStorageAdapter,
  StoragePathError,
  verifyMagicBytesForMime,
} from '@forge-fr/storage';

const storage = createMemoryStorageAdapter();
const pngHeader = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

assert.equal(verifyMagicBytesForMime(pngHeader, 'image/png'), true);
await assert.rejects(
  () => storage.put('../etc/passwd', 'blocked', { contentType: 'text/plain' }),
  StoragePathError,
);

const stored = await storage.put('avatars/u1.png', pngHeader, { contentType: 'image/png' });
assert.equal(stored.key, 'avatars/u1.png');
```
