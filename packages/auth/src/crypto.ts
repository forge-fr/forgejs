const TEXT_ENCODER = new TextEncoder();

export function generateRandomBytes(byteLength: number): Uint8Array {
  if (!Number.isInteger(byteLength) || byteLength < 1 || byteLength > 4096) {
    throw new RangeError('byteLength must be an integer between 1 and 4096');
  }
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (padded.length % 4)) % 4;
  const binary = atob(padded + '='.repeat(padLen));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export function generateSecureToken(byteLength = 32): string {
  return base64UrlEncode(generateRandomBytes(byteLength));
}

export async function sha256Bytes(input: string | Uint8Array): Promise<Uint8Array> {
  const data = typeof input === 'string' ? TEXT_ENCODER.encode(input) : input;
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', copy.buffer);
  return new Uint8Array(digest);
}

export async function sha256Base64Url(input: string | Uint8Array): Promise<string> {
  return base64UrlEncode(await sha256Bytes(input));
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes = await sha256Bytes(input);
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Constant-time byte comparison avoiding timing leaks on secret tokens/digests.
 */
export function constantTimeEqual(a: string | Uint8Array, b: string | Uint8Array): boolean {
  const bytesA = typeof a === 'string' ? TEXT_ENCODER.encode(a) : a;
  const bytesB = typeof b === 'string' ? TEXT_ENCODER.encode(b) : b;

  const maxLen = Math.max(bytesA.length, bytesB.length);
  let diff = bytesA.length ^ bytesB.length;
  for (let i = 0; i < maxLen; i += 1) {
    const ba = i < bytesA.length ? bytesA[i]! : 0;
    const bb = i < bytesB.length ? bytesB[i]! : 0;
    diff |= ba ^ bb;
  }
  return diff === 0;
}
