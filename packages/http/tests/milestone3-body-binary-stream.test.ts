import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_MULTIPART_BYTES,
  PayloadTooLargeError,
  UnsupportedMediaTypeError,
  createHttpApp,
  formatContentDisposition,
  readBoundedMultipart,
  readBoundedText,
  readMultipartStream,
  sanitizeUploadFilename,
  verifyUploadMagicBytes,
  type MultipartStreamPart,
} from '../src/index.js';

const PNG_HEADER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const JPEG_HEADER = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PDF_HEADER = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n');

function buildRawMultipartBody(
  boundary: string,
  parts: readonly {
    readonly name: string;
    readonly filename?: string;
    readonly contentType?: string;
    readonly data: string | Uint8Array;
  }[],
): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    let header = `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"`;
    if (part.filename !== undefined) {
      header += `; filename="${part.filename}"`;
    }
    header += '\r\n';
    if (part.contentType !== undefined) {
      header += `Content-Type: ${part.contentType}\r\n`;
    }
    header += '\r\n';
    chunks.push(enc.encode(header));
    chunks.push(typeof part.data === 'string' ? enc.encode(part.data) : part.data);
    chunks.push(enc.encode('\r\n'));
  }
  chunks.push(enc.encode(`--${boundary}--\r\n`));

  const total = chunks.reduce((acc, c) => acc + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function createChunkedStream(data: Uint8Array, chunkSize: number, onCancel?: () => void): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= data.byteLength) {
        controller.close();
        return;
      }
      const next = data.slice(offset, Math.min(data.byteLength, offset + chunkSize));
      offset += next.byteLength;
      controller.enqueue(next);
    },
    cancel() {
      onCancel?.();
    },
  });
}

describe('Milestone 3 — HTTP Security Hardening, Multipart Streaming & Binary Responses', () => {
  describe('SEC-01: Streaming bounded text reader (DoS protection)', () => {
    it('cancels chunked Transfer-Encoding stream immediately when exceeding maxBytes without Content-Length', async () => {
      let chunksPulled = 0;
      let cancelled = false;
      const chunk = new Uint8Array(64).fill(65); // 'A' * 64

      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          chunksPulled += 1;
          if (chunksPulled > 100) {
            controller.close();
            return;
          }
          controller.enqueue(chunk);
        },
        cancel() {
          cancelled = true;
        },
      });

      // No content-length header — simulates chunked streaming upload DoS
      const req = new Request('http://forge.local/text', {
        method: 'POST',
        body: stream,
        duplex: 'half',
      } as RequestInit);

      await expect(readBoundedText(req, { maxBytes: 128 })).rejects.toBeInstanceOf(
        PayloadTooLargeError,
      );
      expect(cancelled).toBe(true);
      expect(chunksPulled).toBeLessThanOrEqual(4);
    });
  });

  describe('SEC-02: Multipart defaults, filename sanitization, MIME/extension & magic-byte validation', () => {
    it('exports 10 MiB DEFAULT_MAX_MULTIPART_BYTES reconciling 5 MiB per-file limit', () => {
      expect(DEFAULT_MAX_MULTIPART_BYTES).toBe(10 * 1_048_576);
    });

    it('sanitizes dangerous upload filenames (path traversal, Windows reserved, control bytes)', () => {
      expect(sanitizeUploadFilename('../../etc/passwd')).toBe('passwd');
      expect(sanitizeUploadFilename('..\\..\\Windows\\System32\\cmd.exe')).toBe('cmd.exe');
      expect(sanitizeUploadFilename('CON.txt')).toBe('_CON.txt');
      expect(sanitizeUploadFilename('report\r\nX-Injected: yes.pdf')).toBe('reportX-Injected_ yes.pdf');
      expect(sanitizeUploadFilename('...')).toBe('upload');
      expect(sanitizeUploadFilename('invoice-2026.pdf')).toBe('invoice-2026.pdf');
    });

    it('verifies magic bytes for PNG, JPEG, PDF and rejects spoofed binary content', () => {
      expect(verifyUploadMagicBytes(PNG_HEADER, 'image/png')).toBe(true);
      expect(verifyUploadMagicBytes(JPEG_HEADER, 'image/jpeg')).toBe(true);
      expect(verifyUploadMagicBytes(PDF_HEADER, 'application/pdf')).toBe(true);

      const fakePng = new TextEncoder().encode('<script>alert(1)</script>');
      expect(verifyUploadMagicBytes(fakePng, 'image/png')).toBe(false);
      expect(verifyUploadMagicBytes(fakePng, 'application/pdf')).toBe(false);
      // Plain text has no fixed magic bytes
      expect(verifyUploadMagicBytes(fakePng, 'text/plain')).toBe(true);
    });

    it('sanitizes filenames, validates MIME/extensions/magic bytes in readBoundedMultipart & ctx.formData()', async () => {
      const boundary = 'forge-m3-boundary';
      const raw = buildRawMultipartBody(boundary, [
        { name: 'caption', data: 'Launch banner' },
        { name: '__proto__', data: 'blocked' },
        {
          name: 'image',
          filename: '../../evil/banner.png',
          contentType: 'image/png',
          data: PNG_HEADER,
        },
      ]);

      const app = createHttpApp();
      app.post('/upload', async (ctx) => {
        const parsed = await ctx.formData({
          allowedMimeTypes: ['image/*'],
          allowedExtensions: ['.png', '.jpg'],
          verifyMagicBytes: true,
        });
        return ctx.json({
          caption: parsed.fields.caption,
          hasProto: '__proto__' in parsed.fields,
          fileName: parsed.files[0]?.name,
          rawName: parsed.files[0]?.rawName,
          fileSize: parsed.files[0]?.size,
        });
      });

      const res = await app.fetch(
        new Request('http://forge.local/upload', {
          method: 'POST',
          headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
          body: raw as Uint8Array<ArrayBuffer>,
        }),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        caption: 'Launch banner',
        hasProto: false,
        fileName: 'banner.png',
        rawName: '../../evil/banner.png',
        fileSize: PNG_HEADER.byteLength,
      });
    });

    it('rejects spoofed PNG magic bytes and disallowed extensions with 415 UnsupportedMediaTypeError', async () => {
      const boundary = 'forge-m3-spoof';
      const spoofedBody = buildRawMultipartBody(boundary, [
        {
          name: 'avatar',
          filename: 'avatar.png',
          contentType: 'image/png',
          data: new TextEncoder().encode('NOT_A_PNG_FILE_CONTENT'),
        },
      ]);

      const reqSpoof = new Request('http://forge.local/upload', {
        method: 'POST',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        body: spoofedBody as Uint8Array<ArrayBuffer>,
      });

      await expect(
        readBoundedMultipart(reqSpoof, {
          allowedMimeTypes: ['image/png'],
          verifyMagicBytes: true,
        }),
      ).rejects.toBeInstanceOf(UnsupportedMediaTypeError);

      const badExtBody = buildRawMultipartBody(boundary, [
        {
          name: 'script',
          filename: 'shell.php',
          contentType: 'image/png',
          data: PNG_HEADER,
        },
      ]);
      const reqBadExt = new Request('http://forge.local/upload', {
        method: 'POST',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        body: badExtBody as Uint8Array<ArrayBuffer>,
      });

      await expect(
        readBoundedMultipart(reqBadExt, {
          allowedExtensions: ['png', 'jpg'],
        }),
      ).rejects.toBeInstanceOf(UnsupportedMediaTypeError);
    });
  });

  describe('Streaming RFC 7578 multipart parser (ctx.body.multipartStream)', () => {
    it('streams multiple fields and files incrementally across tiny chunk boundaries', async () => {
      const boundary = 'forge-stream-bound-99';
      const payload = buildRawMultipartBody(boundary, [
        { name: 'title', data: 'Streaming Docs' },
        { name: '__proto__', data: 'ignored' },
        {
          name: 'doc',
          filename: '../nested/manual.pdf',
          contentType: 'application/pdf',
          data: PDF_HEADER,
        },
        { name: 'tag', data: 'v1' },
        {
          name: 'logo',
          filename: 'logo.png',
          contentType: 'image/png',
          data: PNG_HEADER,
        },
      ]);

      // Use 7-byte chunks to force boundaries and headers to split across chunks!
      const req = new Request('http://forge.local/stream-upload', {
        method: 'POST',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        body: createChunkedStream(payload, 7),
        duplex: 'half',
      } as RequestInit);

      const collected: Array<{ kind: string; fieldName: string; name?: string; rawName?: string; size?: number; value?: string }> = [];
      for await (const part of readMultipartStream(req, {
        allowedMimeTypes: ['application/pdf', 'image/png'],
        verifyMagicBytes: true,
      })) {
        if (part.kind === 'field') {
          collected.push({ kind: 'field', fieldName: part.fieldName, value: part.value });
        } else {
          const bytes = await part.bytes();
          collected.push({
            kind: 'file',
            fieldName: part.fieldName,
            name: part.name,
            rawName: part.rawName,
            size: bytes.byteLength,
          });
        }
      }

      expect(collected).toEqual([
        { kind: 'field', fieldName: 'title', value: 'Streaming Docs' },
        {
          kind: 'file',
          fieldName: 'doc',
          name: 'manual.pdf',
          rawName: '../nested/manual.pdf',
          size: PDF_HEADER.byteLength,
        },
        { kind: 'field', fieldName: 'tag', value: 'v1' },
        {
          kind: 'file',
          fieldName: 'logo',
          name: 'logo.png',
          rawName: 'logo.png',
          size: PNG_HEADER.byteLength,
        },
      ]);
    });

    it('cancels underlying request body cleanly on early break in consumer loop', async () => {
      const boundary = 'forge-early-exit';
      const bigData = new Uint8Array(4096).fill(88);
      const payload = buildRawMultipartBody(boundary, [
        { name: 'first', data: 'stop-here' },
        { name: 'second', filename: 'big.bin', contentType: 'application/octet-stream', data: bigData },
      ]);

      let cancelled = false;
      const req = new Request('http://forge.local/early', {
        method: 'POST',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        body: createChunkedStream(payload, 32, () => {
          cancelled = true;
        }),
        duplex: 'half',
      } as RequestInit);

      const seen: MultipartStreamPart[] = [];
      for await (const part of readMultipartStream(req)) {
        seen.push(part);
        break;
      }

      expect(seen).toHaveLength(1);
      expect(seen[0]?.kind).toBe('field');
      expect(cancelled).toBe(true);
    });

    it('exposes ctx.body.multipartStream() and rejects spoofed magic bytes before yielding file', async () => {
      const boundary = 'forge-ctx-stream';
      const spoofed = buildRawMultipartBody(boundary, [
        {
          name: 'img',
          filename: 'fake.png',
          contentType: 'image/png',
          data: new TextEncoder().encode('spoofed-png-bytes-payload'),
        },
      ]);

      const app = createHttpApp();
      app.post('/stream', async (ctx) => {
        for await (const part of ctx.body.multipartStream({ verifyMagicBytes: true })) {
          if (part.kind === 'file') {
            await part.bytes();
          }
        }
        return ctx.json({ ok: true });
      });

      const res = await app.fetch(
        new Request('http://forge.local/stream', {
          method: 'POST',
          headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
          body: spoofed as Uint8Array<ArrayBuffer>,
        }),
      );
      expect(res.status).toBe(415);
    });
  });

  describe('Binary, Download & Streaming responses (ctx.binary, ctx.download, ctx.stream)', () => {
    it('formats RFC 6266 / RFC 5987 Content-Disposition safely and neutralizes header injection', () => {
      expect(formatContentDisposition('report.pdf')).toBe('attachment; filename="report.pdf"');
      expect(formatContentDisposition('photo.png', 'inline')).toBe('inline; filename="photo.png"');
      expect(formatContentDisposition('../../secret/invoice\r\nX-Evil: 1.pdf')).toBe(
        'attachment; filename="invoiceX-Evil_ 1.pdf"',
      );
      const utf8Header = formatContentDisposition('laporan-keuangan-é.pdf');
      expect(utf8Header).toContain('attachment; filename="laporan-keuangan-_.pdf"');
      expect(utf8Header).toContain("filename*=UTF-8''laporan-keuangan-%C3%A9.pdf");
    });

    it('serves Uint8Array, ArrayBuffer, and Blob via ctx.binary() with Content-Length, Cache-Control, ETag, and HEAD support', async () => {
      const app = createHttpApp();
      app.get('/bin-u8', (ctx) =>
        ctx.binary(PNG_HEADER, {
          contentType: 'image/png',
          cacheControl: 'public, max-age=3600',
          etag: '"png-v1"',
        }),
      );
      app.head('/bin-u8', (ctx) =>
        ctx.binary(PNG_HEADER, {
          contentType: 'image/png',
          etag: '"png-v1"',
        }),
      );
      app.get('/bin-ab', (ctx) => ctx.binary(JPEG_HEADER.slice().buffer, 'image/jpeg'));
      app.get('/bin-blob', (ctx) =>
        ctx.binary(new Blob([PDF_HEADER], { type: 'application/pdf' })),
      );

      const resU8 = await app.fetch(new Request('http://forge.local/bin-u8'));
      expect(resU8.status).toBe(200);
      expect(resU8.headers.get('content-type')).toBe('image/png');
      expect(resU8.headers.get('content-length')).toBe(String(PNG_HEADER.byteLength));
      expect(resU8.headers.get('cache-control')).toBe('public, max-age=3600');
      expect(resU8.headers.get('etag')).toBe('"png-v1"');
      expect(new Uint8Array(await resU8.arrayBuffer())).toEqual(PNG_HEADER);

      const resHead = await app.fetch(new Request('http://forge.local/bin-u8', { method: 'HEAD' }));
      expect(resHead.status).toBe(200);
      expect(resHead.headers.get('content-length')).toBe(String(PNG_HEADER.byteLength));
      expect((await resHead.arrayBuffer()).byteLength).toBe(0);

      const resAb = await app.fetch(new Request('http://forge.local/bin-ab'));
      expect(resAb.headers.get('content-type')).toBe('image/jpeg');
      expect(new Uint8Array(await resAb.arrayBuffer())).toEqual(JPEG_HEADER);

      const resBlob = await app.fetch(new Request('http://forge.local/bin-blob'));
      expect(resBlob.headers.get('content-type')).toBe('application/pdf');
      expect(new Uint8Array(await resBlob.arrayBuffer())).toEqual(PDF_HEADER);
    });

    it('serves buffered and streamed downloads via ctx.download() and cancels stream on HEAD', async () => {
      let headStreamCancelled = false;
      const app = createHttpApp();

      app.get('/download-pdf', (ctx) =>
        ctx.download(PDF_HEADER, 'laporan-é.pdf', {
          contentType: 'application/pdf',
          cacheControl: 'private, no-store',
        }),
      );

      app.get('/download-stream', (ctx) => {
        const s = createChunkedStream(PDF_HEADER, 6);
        return ctx.download(s, 'streamed.pdf', {
          contentType: 'application/pdf',
          contentLength: PDF_HEADER.byteLength,
          disposition: 'inline',
        });
      });

      app.head('/download-stream', (ctx) => {
        const s = createChunkedStream(PDF_HEADER, 6, () => {
          headStreamCancelled = true;
        });
        return ctx.download(s, 'streamed.pdf', {
          contentType: 'application/pdf',
          contentLength: PDF_HEADER.byteLength,
        });
      });

      const resPdf = await app.fetch(new Request('http://forge.local/download-pdf'));
      expect(resPdf.status).toBe(200);
      expect(resPdf.headers.get('content-disposition')).toContain("filename*=UTF-8''laporan-%C3%A9.pdf");
      expect(resPdf.headers.get('content-length')).toBe(String(PDF_HEADER.byteLength));
      expect(new Uint8Array(await resPdf.arrayBuffer())).toEqual(PDF_HEADER);

      const resStream = await app.fetch(new Request('http://forge.local/download-stream'));
      expect(resStream.headers.get('content-disposition')).toBe('inline; filename="streamed.pdf"');
      expect(resStream.headers.get('content-length')).toBe(String(PDF_HEADER.byteLength));
      expect(new Uint8Array(await resStream.arrayBuffer())).toEqual(PDF_HEADER);

      const resHead = await app.fetch(
        new Request('http://forge.local/download-stream', { method: 'HEAD' }),
      );
      expect(resHead.status).toBe(200);
      expect(resHead.headers.get('content-length')).toBe(String(PDF_HEADER.byteLength));
      expect((await resHead.arrayBuffer()).byteLength).toBe(0);
      expect(headStreamCancelled).toBe(true);
    });

    it('cancels upstream stream in ctx.stream() when client AbortSignal disconnects or HEAD is called', async () => {
      let upstreamCancelled = false;
      let headCancelled = false;
      const app = createHttpApp();

      app.get('/infinite-stream', (ctx) => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('chunk-1\n'));
          },
          pull() {
            // Keep stream open waiting for abort
            return new Promise<void>(() => {});
          },
          cancel() {
            upstreamCancelled = true;
          },
        });
        return ctx.stream(stream, 'text/plain');
      });

      app.head('/infinite-stream', (ctx) => {
        const stream = new ReadableStream<Uint8Array>({
          cancel() {
            headCancelled = true;
          },
        });
        return ctx.stream(stream, 'text/plain');
      });

      const ac = new AbortController();
      const res = await app.fetch(
        new Request('http://forge.local/infinite-stream', { signal: ac.signal }),
        { signal: ac.signal },
      );

      const reader = res.body!.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toBe('chunk-1\n');

      // Simulate client disconnect
      ac.abort('client-gone');
      await new Promise((r) => setTimeout(r, 15));
      expect(upstreamCancelled).toBe(true);
      reader.releaseLock();

      const headRes = await app.fetch(
        new Request('http://forge.local/infinite-stream', { method: 'HEAD' }),
      );
      expect(headRes.status).toBe(200);
      expect(headCancelled).toBe(true);
    });
  });
});
