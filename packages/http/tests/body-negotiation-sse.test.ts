import { describe, expect, it } from 'vitest';
import {
  BadRequestError,
  PayloadTooLargeError,
  UnsupportedMediaTypeError,
  createSseResponse,
  formatSseEvent,
  negotiateContentType,
  parseAcceptHeader,
  readBoundedBytes,
  readBoundedJson,
  readBoundedMultipart,
  readBoundedText,
  readBoundedUrlEncoded,
} from '../src/index.js';

describe('@forge-fr/http — Bounded Body Parsing, Content Negotiation & SSE', () => {
  it('enforces maxBytes on Content-Length header and on actual streamed bytes even when Content-Length is omitted or forged', async () => {
    const oversized = new Request('http://forge.local/upload', {
      method: 'POST',
      headers: { 'content-length': '500' },
      body: 'x'.repeat(500),
    });

    await expect(readBoundedBytes(oversized, 128)).rejects.toBeInstanceOf(PayloadTooLargeError);

    // Chunked stream with no Content-Length exceeding byte budget
    const chunks = [new Uint8Array(64).fill(65), new Uint8Array(64).fill(66), new Uint8Array(10).fill(67)];
    let index = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[index];
        index += 1;
        if (chunk) {
          controller.enqueue(chunk);
        } else {
          controller.close();
        }
      },
      cancel() {
        cancelled = true;
      },
    });

    const streamedRequest = new Request('http://forge.local/stream', {
      method: 'POST',
      body: stream,
      // @ts-expect-error duplex is required by Node undici Request for ReadableStream bodies
      duplex: 'half',
    });

    await expect(readBoundedBytes(streamedRequest, 128)).rejects.toBeInstanceOf(
      PayloadTooLargeError,
    );
    expect(cancelled).toBe(true);
  });

  it('parses bounded JSON safely and strips prototype-pollution keys by default', async () => {
    const raw =
      '{"name":"alice","__proto__":{"polluted":true},"nested":{"constructor":{"prototype":{"evil":1}},"ok":42}}';
    const req = new Request('http://forge.local/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: raw,
    });

    const parsed = await readBoundedJson<Record<string, unknown>>(req, { maxBytes: 1024 });
    expect(parsed.name).toBe('alice');
    expect(Object.prototype.hasOwnProperty.call(parsed, '__proto__')).toBe(false);
    expect((parsed as { polluted?: boolean }).polluted).toBeUndefined();
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    const nested = parsed.nested as Record<string, unknown>;
    expect(nested.ok).toBe(42);
    expect(Object.prototype.hasOwnProperty.call(nested, 'constructor')).toBe(false);
  });

  it('rejects malformed JSON with BadRequestError and wrong media type with UnsupportedMediaTypeError', async () => {
    const badJson = new Request('http://forge.local/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{invalid',
    });
    await expect(readBoundedJson(badJson)).rejects.toBeInstanceOf(BadRequestError);

    const wrongType = new Request('http://forge.local/users', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{"ok":true}',
    });
    await expect(readBoundedJson(wrongType)).rejects.toBeInstanceOf(UnsupportedMediaTypeError);
  });

  it('parses URL-encoded forms safely with null-prototype record and strips forbidden keys', async () => {
    const req = new Request('http://forge.local/form', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'tag=a&tag=b&name=forge&__proto__=evil&constructor=bad',
    });

    const parsed = await readBoundedUrlEncoded(req, { maxBytes: 1024 });
    expect(Object.getPrototypeOf(parsed)).toBeNull();
    expect(parsed.name).toBe('forge');
    expect(parsed.tag).toEqual(['a', 'b']);
    expect('__proto__' in parsed).toBe(false);
    expect('constructor' in parsed).toBe(false);
  });

  it('parses multipart uploads with strict field, file count, and per-file byte limits', async () => {
    const form = new FormData();
    form.append('title', 'quarterly-report');
    form.append('__proto__', 'blocked');
    form.append('doc', new File(['hello-forge'], 'report.txt', { type: 'text/plain' }));

    const req = new Request('http://forge.local/files', {
      method: 'POST',
      body: form,
    });

    const parsed = await readBoundedMultipart(req, {
      maxBytes: 10_000,
      maxFields: 5,
      maxFiles: 2,
      maxFileBytes: 100,
    });

    expect(Object.getPrototypeOf(parsed.fields)).toBeNull();
    expect(parsed.fields.title).toBe('quarterly-report');
    expect('__proto__' in parsed.fields).toBe(false);
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]?.name).toBe('report.txt');
    expect(await parsed.files[0]?.text()).toBe('hello-forge');

    // Enforce maxFileBytes
    const bigForm = new FormData();
    bigForm.append('doc', new File(['x'.repeat(250)], 'big.bin', { type: 'application/octet-stream' }));
    const bigReq = new Request('http://forge.local/files', { method: 'POST', body: bigForm });

    await expect(
      readBoundedMultipart(bigReq, { maxBytes: 10_000, maxFileBytes: 100 }),
    ).rejects.toBeInstanceOf(PayloadTooLargeError);

    // Enforce maxFiles
    const multiForm = new FormData();
    multiForm.append('a', new File(['1'], 'a.txt'));
    multiForm.append('b', new File(['2'], 'b.txt'));
    const multiReq = new Request('http://forge.local/files', { method: 'POST', body: multiForm });
    await expect(
      readBoundedMultipart(multiReq, { maxBytes: 10_000, maxFiles: 1 }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it('reads bounded UTF-8 text accurately', async () => {
    const req = new Request('http://forge.local/text', {
      method: 'POST',
      body: 'Halo ForgeJS',
    });
    expect(await readBoundedText(req, { maxBytes: 64 })).toBe('Halo ForgeJS');
  });

  it('performs RFC 9110 Accept content negotiation with quality and specificity precedence', () => {
    const parsed = parseAcceptHeader('text/html;q=0.5, application/json;q=0.9, */*;q=0.1');
    expect(parsed[0]?.type).toBe('application/json');
    expect(parsed[0]?.q).toBe(0.9);

    expect(
      negotiateContentType('text/html, application/json;q=0.9, */*;q=0.1', [
        'application/json',
        'text/html',
      ]),
    ).toBe('text/html');

    expect(
      negotiateContentType('text/*;q=0.8, text/plain;q=0.8', ['text/html', 'text/plain']),
    ).toBe('text/plain');

    expect(negotiateContentType('application/xml', ['application/json', 'text/plain'])).toBeNull();
    expect(negotiateContentType(null, ['application/json', 'text/plain'])).toBe('application/json');
  });

  it('formats multi-line SSE events safely and streams SSE responses with abort cleanup', async () => {
    const formatted = formatSseEvent({
      id: 'evt-1',
      event: 'update',
      retry: 3000,
      data: 'line1\nline2',
    });
    expect(formatted).toBe('id: evt-1\nevent: update\nretry: 3000\ndata: line1\ndata: line2\n\n');

    // Reject CRLF injection in SSE event/id fields
    expect(() =>
      formatSseEvent({ id: '1\nevent: forged', data: 'ok' }),
    ).toThrow(BadRequestError);

    let closedNotified = false;
    const response = createSseResponse(async (stream) => {
      stream.send({ event: 'hello', data: { ok: true } });
      stream.comment('keep-alive');
      stream.close();
      closedNotified = stream.closed;
    });

    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-cache, no-transform');
    const bodyText = await response.text();
    expect(bodyText).toContain('event: hello\n');
    expect(bodyText).toContain('data: {"ok":true}\n\n');
    expect(bodyText).toContain(': keep-alive\n\n');
    expect(closedNotified).toBe(true);
  });
});
