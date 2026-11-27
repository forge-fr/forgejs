import { createWebCryptoPasswordHasher } from './webcrypto-password-hasher.ts';

export type Algorithm = 0 | 1 | 2;

const edgeFallbackHasher = createWebCryptoPasswordHasher();

/**
 * Cloudflare Workers alias shim for @node-rs/argon2 so Wrangler/esbuild can
 * bundle @forge-fr/auth cleanly without native .node C++ binaries.
 */
export async function hash(password: string): Promise<string> {
  return edgeFallbackHasher.hash(password);
}

export async function verify(encodedHash: string, password: string): Promise<boolean> {
  return edgeFallbackHasher.verify(password, encodedHash);
}
