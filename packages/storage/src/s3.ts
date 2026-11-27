import { isSecretValue, type SecretValue } from '@forge-fr/core';
import {
  StorageError,
  StorageObjectNotFoundError,
  StorageValidationError,
} from './errors.js';
import type {
  S3StorageOptions,
  StorageAdapter,
  StorageListOptions,
  StorageListResult,
  StorageObject,
  StorageObjectMetadata,
  StoragePutOptions,
  StorageSignedUrlOptions,
  StorageUploadData,
} from './types.js';
import {
  canonicalizeStorageKey,
  computeSha256Hex,
  createStorageObject,
  toArrayBufferCopy,
  validateObjectUpload,
} from './validation.js';

function unwrapSecret(val: string | SecretValue<string>): string {
  return isSecretValue(val) ? val.reveal() : val;
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function encodeS3PathKey(key: string): string {
  return key
    .split('/')
    .map((seg) => encodeRfc3986(seg))
    .join('/');
}

function formatAmzDate(date: Date): { readonly amzDate: string; readonly dateStamp: string } {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return {
    amzDate: iso,
    dateStamp: iso.slice(0, 8),
  };
}

async function hmacSha256Raw(
  keyBytes: Uint8Array,
  data: string,
): Promise<Uint8Array> {
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    'raw',
    toArrayBufferCopy(keyBytes),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await globalThis.crypto.subtle.sign(
    'HMAC',
    cryptoKey,
    toArrayBufferCopy(new TextEncoder().encode(data)),
  );
  return new Uint8Array(sig);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function deriveSigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service = 's3',
): Promise<Uint8Array> {
  const kSecret = new TextEncoder().encode(`AWS4${secretAccessKey}`);
  const kDate = await hmacSha256Raw(kSecret, dateStamp);
  const kRegion = await hmacSha256Raw(kDate, region);
  const kService = await hmacSha256Raw(kRegion, service);
  return hmacSha256Raw(kService, 'aws4_request');
}

function extractXmlTags(xml: string, tagName: string): string[] {
  const results: string[] = [];
  const re = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, 'g');
  for (const match of xml.matchAll(re)) {
    if (match[1] !== undefined) {
      results.push(match[1]);
    }
  }
  return results;
}

export function createS3StorageAdapter(options: S3StorageOptions): StorageAdapter {
  const { bucket, region } = options;
  if (typeof bucket !== 'string' || bucket.trim().length === 0) {
    throw new StorageValidationError('S3 bucket name is required');
  }
  if (typeof region !== 'string' || region.trim().length === 0) {
    throw new StorageValidationError('S3 region is required');
  }

  const endpoint = options.endpoint
    ? options.endpoint.replace(/\/+$/, '')
    : `https://s3.${region}.amazonaws.com`;

  let parsedEndpoint: URL;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch {
    throw new StorageValidationError(`Invalid S3 endpoint URL "${endpoint}"`);
  }

  if (parsedEndpoint.protocol === 'http:' && options.allowInsecureHttp !== true) {
    throw new StorageValidationError(
      'Insecure HTTP S3 endpoint rejected by default; set allowInsecureHttp: true only for local development',
      { endpoint },
    );
  }
  if (parsedEndpoint.protocol !== 'https:' && parsedEndpoint.protocol !== 'http:') {
    throw new StorageValidationError(
      `Unsupported S3 endpoint protocol "${parsedEndpoint.protocol}"`,
      { endpoint },
    );
  }

  const forcePathStyle = options.forcePathStyle ?? options.endpoint !== undefined;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  let connected = false;

  function buildObjectUrl(canonicalKey?: string, queryParams?: URLSearchParams): URL {
    const base = new URL(parsedEndpoint.toString());
    const encodedKey = canonicalKey !== undefined ? encodeS3PathKey(canonicalKey) : '';

    if (forcePathStyle) {
      base.pathname =
        encodedKey.length > 0 ? `/${bucket}/${encodedKey}` : `/${bucket}`;
    } else {
      base.hostname = `${bucket}.${parsedEndpoint.hostname}`;
      base.pathname = encodedKey.length > 0 ? `/${encodedKey}` : '/';
    }

    if (queryParams) {
      base.search = queryParams.toString();
    }
    return base;
  }

  async function signedFetch(
    method: 'PUT' | 'GET' | 'HEAD' | 'DELETE',
    url: URL,
    payload: Uint8Array,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    const accessKeyId = unwrapSecret(options.accessKeyId);
    const secretAccessKey = unwrapSecret(options.secretAccessKey);
    const sessionToken = options.sessionToken ? unwrapSecret(options.sessionToken) : undefined;

    const { amzDate, dateStamp } = formatAmzDate(new Date());
    const payloadHash = await computeSha256Hex(payload);

    const headersMap = new Map<string, string>();
    headersMap.set('host', url.host);
    headersMap.set('x-amz-content-sha256', payloadHash);
    headersMap.set('x-amz-date', amzDate);
    if (sessionToken) {
      headersMap.set('x-amz-security-token', sessionToken);
    }
    for (const [k, v] of Object.entries(extraHeaders)) {
      headersMap.set(k.toLowerCase(), v.trim());
    }

    const sortedHeaderNames = Array.from(headersMap.keys()).sort();
    const canonicalHeaders = sortedHeaderNames
      .map((name) => `${name}:${headersMap.get(name)!}\n`)
      .join('');
    const signedHeaders = sortedHeaderNames.join(';');

    const sortedQuery = Array.from(url.searchParams.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`)
      .join('&');

    const canonicalRequest = [
      method,
      url.pathname,
      sortedQuery,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const canonicalRequestHash = await computeSha256Hex(
      new TextEncoder().encode(canonicalRequest),
    );
    const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      canonicalRequestHash,
    ].join('\n');

    const signingKey = await deriveSigningKey(secretAccessKey, dateStamp, region, 's3');
    const signature = toHex(await hmacSha256Raw(signingKey, stringToSign));
    const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const requestHeaders: Record<string, string> = {
      authorization,
    };
    for (const name of sortedHeaderNames) {
      if (name !== 'host') {
        requestHeaders[name] = headersMap.get(name)!;
      }
    }

    return fetchImpl(url.toString(), {
      method,
      headers: requestHeaders,
      ...(method === 'PUT' ? { body: toArrayBufferCopy(payload) } : {}),
    });
  }

  return {
    driver: 's3',

    async connect(): Promise<void> {
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
        const res = await signedFetch('HEAD', buildObjectUrl(), new Uint8Array());
        return res.status < 500;
      } catch {
        return connected;
      }
    },

    async put(
      key: string,
      data: StorageUploadData,
      putOptions?: StoragePutOptions,
    ): Promise<StorageObjectMetadata> {
      const validated = await validateObjectUpload(key, data, putOptions, options);
      const extraHeaders: Record<string, string> = {
        'content-type': validated.contentType,
      };
      if (putOptions?.cacheControl) {
        extraHeaders['cache-control'] = putOptions.cacheControl;
      }
      if (validated.metadata) {
        for (const [metaKey, metaVal] of Object.entries(validated.metadata)) {
          extraHeaders[`x-amz-meta-${metaKey.toLowerCase()}`] = metaVal;
        }
      }

      const res = await signedFetch(
        'PUT',
        buildObjectUrl(validated.key),
        validated.bytes,
        extraHeaders,
      );
      if (!res.ok) {
        throw new StorageError(`S3 PUT failed with status ${res.status}`, {
          statusCode: res.status,
          details: { key: validated.key },
        });
      }

      const rawEtag = res.headers.get('etag')?.replace(/"/g, '');
      const etag = rawEtag && rawEtag.length > 0 ? rawEtag : await computeSha256Hex(validated.bytes);
      return {
        key: validated.key,
        size: validated.bytes.byteLength,
        etag,
        contentType: validated.contentType,
        lastModified: new Date(),
        ...(validated.metadata !== undefined ? { metadata: validated.metadata } : {}),
      };
    },

    async get(key: string): Promise<StorageObject> {
      const canonical = canonicalizeStorageKey(key);
      const res = await signedFetch('GET', buildObjectUrl(canonical), new Uint8Array());
      if (res.status === 404) {
        throw new StorageObjectNotFoundError(canonical);
      }
      if (!res.ok) {
        throw new StorageError(`S3 GET failed with status ${res.status}`, {
          statusCode: res.status,
          details: { key: canonical },
        });
      }

      const bytes = new Uint8Array(await res.arrayBuffer());
      const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
      const etag = res.headers.get('etag')?.replace(/"/g, '') ?? (await computeSha256Hex(bytes));
      const lastModHeader = res.headers.get('last-modified');
      const metadata: StorageObjectMetadata = {
        key: canonical,
        size: bytes.byteLength,
        etag,
        contentType,
        lastModified: lastModHeader ? new Date(lastModHeader) : new Date(),
      };
      return createStorageObject(metadata, bytes);
    },

    async head(key: string): Promise<StorageObjectMetadata | undefined> {
      const canonical = canonicalizeStorageKey(key);
      const res = await signedFetch('HEAD', buildObjectUrl(canonical), new Uint8Array());
      if (res.status === 404) {
        return undefined;
      }
      if (!res.ok) {
        throw new StorageError(`S3 HEAD failed with status ${res.status}`, {
          statusCode: res.status,
          details: { key: canonical },
        });
      }

      const contentLength = Number.parseInt(res.headers.get('content-length') ?? '0', 10);
      const lastModHeader = res.headers.get('last-modified');
      return {
        key: canonical,
        size: Number.isFinite(contentLength) ? contentLength : 0,
        etag: res.headers.get('etag')?.replace(/"/g, '') ?? '',
        contentType: res.headers.get('content-type') ?? 'application/octet-stream',
        lastModified: lastModHeader ? new Date(lastModHeader) : new Date(),
      };
    },

    async exists(key: string): Promise<boolean> {
      return (await this.head(key)) !== undefined;
    },

    async delete(key: string): Promise<boolean> {
      const canonical = canonicalizeStorageKey(key);
      const res = await signedFetch('DELETE', buildObjectUrl(canonical), new Uint8Array());
      if (res.status === 404) {
        return false;
      }
      if (!res.ok) {
        throw new StorageError(`S3 DELETE failed with status ${res.status}`, {
          statusCode: res.status,
          details: { key: canonical },
        });
      }
      return true;
    },

    async list(listOptions: StorageListOptions = {}): Promise<StorageListResult> {
      const params = new URLSearchParams({ 'list-type': '2' });
      if (listOptions.prefix) {
        params.set('prefix', listOptions.prefix);
      }
      if (listOptions.cursor) {
        params.set('continuation-token', listOptions.cursor);
      }
      if (listOptions.limit !== undefined) {
        params.set('max-keys', String(listOptions.limit));
      }

      const res = await signedFetch('GET', buildObjectUrl(undefined, params), new Uint8Array());
      if (!res.ok) {
        throw new StorageError(`S3 LIST failed with status ${res.status}`, {
          statusCode: res.status,
        });
      }

      const xml = await res.text();
      const contentsBlocks = extractXmlTags(xml, 'Contents');
      const objects: StorageObjectMetadata[] = contentsBlocks.map((block) => {
        const key = extractXmlTags(block, 'Key')[0] ?? '';
        const size = Number.parseInt(extractXmlTags(block, 'Size')[0] ?? '0', 10);
        const etag = (extractXmlTags(block, 'ETag')[0] ?? '').replace(/"/g, '');
        const lastModRaw = extractXmlTags(block, 'LastModified')[0];
        return {
          key,
          size: Number.isFinite(size) ? size : 0,
          etag,
          contentType: 'application/octet-stream',
          lastModified: lastModRaw ? new Date(lastModRaw) : new Date(),
        };
      });

      const nextCursor = extractXmlTags(xml, 'NextContinuationToken')[0];
      return {
        objects,
        ...(nextCursor !== undefined ? { nextCursor } : {}),
      };
    },

    async getSignedUrl(
      key: string,
      signedOptions: StorageSignedUrlOptions = {},
    ): Promise<string> {
      const canonical = canonicalizeStorageKey(key);
      const expiresIn = signedOptions.expiresInSeconds ?? 300;
      if (!Number.isFinite(expiresIn) || expiresIn < 1 || expiresIn > 604_800) {
        throw new StorageValidationError(
          'S3 presigned URL expiresInSeconds must be between 1 and 604800 seconds',
        );
      }

      const method = signedOptions.method ?? 'GET';
      const accessKeyId = unwrapSecret(options.accessKeyId);
      const secretAccessKey = unwrapSecret(options.secretAccessKey);
      const sessionToken = options.sessionToken ? unwrapSecret(options.sessionToken) : undefined;
      const { amzDate, dateStamp } = formatAmzDate(new Date());
      const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;

      const targetUrl = buildObjectUrl(canonical);
      const queryEntries: [string, string][] = [
        ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
        ['X-Amz-Credential', `${accessKeyId}/${credentialScope}`],
        ['X-Amz-Date', amzDate],
        ['X-Amz-Expires', String(Math.trunc(expiresIn))],
        ['X-Amz-SignedHeaders', 'host'],
      ];
      if (sessionToken) {
        queryEntries.push(['X-Amz-Security-Token', sessionToken]);
      }
      queryEntries.sort(([a], [b]) => a.localeCompare(b));

      const canonicalQuery = queryEntries
        .map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`)
        .join('&');

      const canonicalRequest = [
        method,
        targetUrl.pathname,
        canonicalQuery,
        `host:${targetUrl.host}\n`,
        'host',
        'UNSIGNED-PAYLOAD',
      ].join('\n');

      const canonicalRequestHash = await computeSha256Hex(
        new TextEncoder().encode(canonicalRequest),
      );
      const stringToSign = [
        'AWS4-HMAC-SHA256',
        amzDate,
        credentialScope,
        canonicalRequestHash,
      ].join('\n');

      const signingKey = await deriveSigningKey(secretAccessKey, dateStamp, region, 's3');
      const signature = toHex(await hmacSha256Raw(signingKey, stringToSign));

      return `${targetUrl.origin}${targetUrl.pathname}?${canonicalQuery}&X-Amz-Signature=${signature}`;
    },
  };
}
