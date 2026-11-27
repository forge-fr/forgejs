import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { secret } from '@forge-fr/core';
import { createPluginTestHarness } from '@forge-fr/testing';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  StorageObjectNotFoundError,
  StoragePathError,
  StorageTokens,
  StorageValidationError,
  canonicalizeStorageKey,
  createLocalStorageAdapter,
  createMemoryStorageAdapter,
  createS3StorageAdapter,
  createStoragePlugin,
} from '@forge-fr/storage';

const MINIMAL_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

describe('@forge-fr/storage — Local Root-Jailed, S3 SigV4, Memory & Security Controls', () => {
  it('enforces canonical key safety, MIME allowlist, binary magic-byte sniffing, size limits, and 100-run key fuzzing', async () => {
    const mem = createMemoryStorageAdapter({
      allowedMimeTypes: ['image/png', 'application/json'],
      verifyMagicBytes: true,
      maxObjectBytes: 64,
    });
    await mem.connect();

    // Reject path traversal & OS quirks
    const maliciousKeys = [
      '../secret.txt',
      'uploads/%2e%2e/etc/passwd',
      'uploads/%252e%252e/shadow',
      '/leading/slash.png',
      'win\\backslash.png',
      'C:\\evil.png',
      'uploads/null\0.png',
      'uploads/CON.png',
      'uploads/./hidden',
    ];
    for (const bad of maliciousKeys) {
      expect(() => canonicalizeStorageKey(bad)).toThrow(StoragePathError);
      await expect(mem.put(bad, MINIMAL_PNG, { contentType: 'image/png' })).rejects.toThrow(
        StoragePathError,
      );
    }

    // Reject disallowed MIME type and spoofed Content-Type (HTML claiming image/png!)
    await expect(
      mem.put('docs/page.html', new TextEncoder().encode('<script>alert(1)</script>'), {
        contentType: 'text/html',
      }),
    ).rejects.toThrow(StorageValidationError);

    await expect(
      mem.put('avatars/fake.png', new TextEncoder().encode('<html>xss</html>'), {
        contentType: 'image/png',
      }),
    ).rejects.toThrow(StorageValidationError);

    // Reject oversized objects
    await expect(
      mem.put('avatars/huge.png', new Uint8Array(128).fill(1), { contentType: 'image/png' }),
    ).rejects.toThrow(StorageValidationError);

    // Valid PNG accepted and readable
    const meta = await mem.put('avatars/u1.png', MINIMAL_PNG, {
      contentType: 'image/png',
      metadata: { owner: 'u1' },
    });
    expect(meta.key).toBe('avatars/u1.png');
    expect(meta.size).toBe(MINIMAL_PNG.byteLength);
    expect(meta.etag).toMatch(/^[0-9a-f]{64}$/);

    const obj = await mem.get('avatars/u1.png');
    expect(obj.metadata.metadata?.['owner']).toBe('u1');
    expect(new Uint8Array(await obj.arrayBuffer())).toEqual(MINIMAL_PNG);

    // Signed URL generation on memory adapter
    const signed = await mem.getSignedUrl?.('avatars/u1.png', { expiresInSeconds: 60 });
    expect(signed).toContain('signature=');

    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 30 }).filter((s) => !s.includes('/') && !s.includes('\\')),
        async (seg) => {
          const validSegment = /^[A-Za-z0-9_-]{1,30}$/.test(seg);
          if (validSegment && seg !== 'CON') {
            expect(canonicalizeStorageKey(`f/${seg}.png`)).toBe(`f/${seg}.png`);
          }
        },
      ),
      { numRuns: 100 },
    );

    await mem.disconnect();
  });

  it('jails createLocalStorageAdapter inside rootDir and blocks symlink traversal escapes', async () => {
    const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-storage-test-'));
    const rootDir = path.join(tmpBase, 'bucket');
    const outsideDir = path.join(tmpBase, 'outside');
    const outsideSecret = path.join(outsideDir, 'secret.txt');

    try {
      await fs.mkdir(rootDir, { recursive: true });
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.writeFile(outsideSecret, 'TOP_SECRET_HOST_FILE', 'utf8');

      // Plant symlink inside rootDir pointing outside rootDir
      await fs.symlink(outsideDir, path.join(rootDir, 'escape-link'));

      const local = createLocalStorageAdapter({ rootDir });
      await local.connect();

      // Reading OR writing through symlink pointing outside rootDir must fail with StoragePathError
      await expect(local.get('escape-link/secret.txt')).rejects.toThrow(StoragePathError);
      await expect(
        local.put('escape-link/pwn.png', MINIMAL_PNG, { contentType: 'image/png' }),
      ).rejects.toThrow(StoragePathError);

      // Normal jailed operations succeed
      await local.put('tenants/t1/logo.png', MINIMAL_PNG, { contentType: 'image/png' });
      expect(await local.exists('tenants/t1/logo.png')).toBe(true);

      const loaded = await local.get('tenants/t1/logo.png');
      expect(loaded.metadata.contentType).toBe('image/png');
      expect(new Uint8Array(await loaded.arrayBuffer())).toEqual(MINIMAL_PNG);

      const listing = await local.list({ prefix: 'tenants/t1/' });
      expect(listing.objects.map((o) => o.key)).toEqual(['tenants/t1/logo.png']);

      await local.delete('tenants/t1/logo.png');
      expect(await local.exists('tenants/t1/logo.png')).toBe(false);
      await expect(local.get('tenants/t1/logo.png')).rejects.toThrow(StorageObjectNotFoundError);

      await local.disconnect();
    } finally {
      await fs.rm(tmpBase, { recursive: true, force: true });
    }
  });

  it('signs S3 requests & presigned URLs via Web Crypto SigV4, blocks insecure HTTP by default, and integrates DI plugin', async () => {
    // Disallow plain http:// unless explicitly opted in
    expect(() =>
      createS3StorageAdapter({
        bucket: 'uploads',
        region: 'auto',
        endpoint: 'http://127.0.0.1:9000',
        accessKeyId: secret('AKIAEXAMPLE123'),
        secretAccessKey: secret('SuperSecretS3Key123456'),
      }),
    ).toThrow(StorageValidationError);

    const recordedRequests: Array<{ url: string; method: string; auth: string | null }> = [];
    const backing = new Map<string, { body: Uint8Array; contentType: string; etag: string }>();

    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? 'GET';
      const headers = new Headers(init?.headers);
      recordedRequests.push({ url, method, auth: headers.get('authorization') });

      const parsed = new URL(url);
      const key = parsed.pathname.replace(/^\/uploads\//, '');

      if (method === 'PUT') {
        const body = init?.body ? new Uint8Array(await new Response(init.body).arrayBuffer()) : new Uint8Array();
        const etag = '"abc123etag"';
        backing.set(key, {
          body,
          contentType: headers.get('content-type') ?? 'application/octet-stream',
          etag,
        });
        return new Response(null, { status: 200, headers: { etag } });
      }
      if (method === 'HEAD' || method === 'GET') {
        const found = backing.get(key);
        if (!found) return new Response(null, { status: 404 });
        return new Response(method === 'HEAD' ? null : new Uint8Array(found.body), {
          status: 200,
          headers: {
            'content-type': found.contentType,
            'content-length': String(found.body.byteLength),
            etag: found.etag,
          },
        });
      }
      if (method === 'DELETE') {
        backing.delete(key);
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 400 });
    };

    const s3 = createS3StorageAdapter({
      bucket: 'uploads',
      region: 'us-east-1',
      endpoint: 'https://s3.example.internal',
      forcePathStyle: true,
      accessKeyId: secret('AKIAEXAMPLE123'),
      secretAccessKey: secret('SuperSecretS3Key123456'),
      fetch: mockFetch,
    });
    await s3.connect();

    await s3.put('invoices/2026/a.png', MINIMAL_PNG, { contentType: 'image/png' });
    expect(recordedRequests[0]?.method).toBe('PUT');
    expect(recordedRequests[0]?.url).toBe('https://s3.example.internal/uploads/invoices/2026/a.png');
    expect(recordedRequests[0]?.auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE123\/\d{8}\/us-east-1\/s3\/aws4_request/);

    const fetched = await s3.get('invoices/2026/a.png');
    expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(MINIMAL_PNG);

    const presigned = await s3.getSignedUrl('invoices/2026/a.png', { expiresInSeconds: 300 });
    expect(presigned).toContain('X-Amz-Algorithm=AWS4-HMAC-SHA256');
    expect(presigned).toContain('X-Amz-Expires=300');
    expect(presigned).toContain('X-Amz-Signature=');
    expect(presigned).not.toContain('SuperSecretS3Key123456');

    const harness = createPluginTestHarness({
      plugin: createStoragePlugin({ adapter: s3 }),
    });
    await harness.start();
    const injected = harness.resolveExport(StorageTokens.Adapter);
    expect(injected.driver).toBe('s3');
    const health = await harness.health();
    expect(health.status).toBe('ok');
    expect(health.checks['storage']?.status).toBe('ok');
    await harness.shutdown();
  });
});
