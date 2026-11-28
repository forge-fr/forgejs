# File Storage & S3

> Store files in memory, on local disk, or on S3 (without the AWS SDK) with path-traversal protection and file signature checks.

- **Section**: Advanced Features
- **Packages**: @forge-fr/storage
- **Version**: v1.0.0
- **Updated**: 2026-11-27
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/advanced/storage
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/advanced/storage.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/infrastructure-and-cli.md

## Safe file keys, local disk jails & zero-SDK S3

- Every adapter validates file keys and blocks path-escape attempts (like ../ or null bytes) with StoragePathError.
- createLocalStorageAdapter() checks real filesystem paths so symlinks cannot escape your upload directory.
- createS3StorageAdapter() signs AWS SigV4 requests using built-in Web Crypto (no heavy AWS SDK) over HTTPS by default.
- verifyMagicBytesForMime() checks the actual first bytes of a file to confirm it matches its claimed file type.

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
