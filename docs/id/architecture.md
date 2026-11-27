# Arsitektur Inti, Dependency Injection & Sistem Plugin ForgeJS

Arsitektur ForgeJS memisahkan tiga lapisan secara tegas agar logika bisnis tidak bergantung pada detail runtime Node.js atau Bun:

1. **Framework Core (`@forge-fr/core`, `@forge-fr/router`, `@forge-fr/http`):** Murni Web Standards tanpa import `node:*` atau global `Bun`.
2. **Adapter Layer (`@forge-fr/node`, `@forge-fr/bun`, `@forge-fr/edge`):** Menghubungkan mesin HTTP ke `node:http`, `Bun.serve()`, maupun WinterCG / Cloudflare Workers / Deno.
3. **Infrastructure & Security Layers:** Modul siap produksi untuk database, auth, otorisasi, keamanan, observabilitas, cache, queue (Memory/Redis/PostgreSQL `SKIP LOCKED`), dan storage.

## Enkapsulasi Modul & Lifecycle 7-Tahap Kernel

Setiap modul hanya mengekspos provider yang didaftarkan di `exports`, sedangkan provider internal tetap terisolasi:

```ts forge-example
import assert from 'node:assert/strict';
import { createKernel, createToken, defineModule } from '@forge-fr/core';

const RahasiaToken = createToken<string>('internal.rahasia');
const LayananToken = createToken<{ baca(): string }>('publik.layanan');

const ModulInti = defineModule({
  name: 'inti',
  providers: [
    { token: RahasiaToken, useValue: 'internal-saja' },
    {
      token: LayananToken,
      useFactory: (r) => ({ baca: () => `ok:${r.resolve(RahasiaToken).length}` }),
    },
  ],
  exports: [LayananToken],
});

const kernel = createKernel({ modules: [ModulInti] });
await kernel.start();

assert.equal(kernel.container.resolve(LayananToken).baca(), 'ok:13');
assert.equal(kernel.state, 'ready');

await kernel.dispose();
```

## Arsitektur Hot-Path Berkinerja Tinggi (Node.js 22 & Bun 1.4)

Mesin HTTP dan adapter runtime ForgeJS menerapkan arsitektur optimasi jalur kritis (*hot-path*) Fase 2 tanpa mengorbankan kompatibilitas Web Standards:

1. **O(1) `staticByMethod` Sebelum Normalisasi & Radix Scratch Buffer (`@forge-fr/router`):** Rute statis dicocokkan langsung pada `staticByMethod[method]?.get(rawPath)` sebelum `normalizePathname()`, sementara pencocokan Radix dinamis memakai ulang array penampung (*scratch captures*) tanpa alokasi baru.
2. **Slicing URL Tanpa Alokasi, `ForgeContext` Ringkas & Lazy `requestId` (`@forge-fr/http`):** Ekstraksi `pathname` dan `query` dilakukan dengan operasi string langsung tanpa `new URL()` atau `URLSearchParams`. `ForgeContextImpl` memisahkan 13 field panas dari *cold state* (`url`, `query`, `headers`, `logger`, `signal`, `scope`), serta membangkitkan `requestId` / header `x-request-id` secara *lazy* (saat diakses, saat error, atau saat `trustRequestId: true`).
3. **Lazy Node `FastResponse` & Pre-Allocated Bun `Headers` (`@forge-fr/http`):** Di Node.js, `FastResponse` berbasis `Response.prototype` menunda alokasi `_fastHeaders` untuk melewati overhead konstruktor C++ Undici; di Bun, `new Response()` memakai preset `GlobalHeaders` teralokasi awal (`2.16x` lebih cepat dengan isolasi mutasi header penuh).
4. **Inline Route Pipeline Cache & `compileFastValidator` (`@forge-fr/http`, `@forge-fr/validation`):** Pipeline middleware di-cache langsung pada objek rute (`route._pipelineRun`, menggantikan `WeakMap`) secara sinkron-pertama. `compileFastValidator()` memanfaatkan `schema.safeParse()` langsung pada Zod v4 (`2.6x` lebih cepat) dipadukan dengan pembaca body JSON sinkron-pertama dan pemindaian anti-prototype-pollution di memori, dengan *fallback* otomatis ke Standard Schema `validate()` untuk skema async, Valibot, maupun ArkType.
5. **Direct-Meta `NodeAdapter` & Pure-HTTP `BunAdapter` (`@forge-fr/node`, `@forge-fr/bun`):** `FastNodeRequest` mengimplementasikan metadata secara langsung dengan header statis ter-cache dan `trySetNodeContentLength()` pada `writeFastResponseSync`. `BunAdapter` menjalankan mode `Bun.serve()` HTTP murni saat rute WebSocket kosong, mengganti `Set<Promise>` dengan penghitung integer `inFlightCount`, dan memakai ulang satu objek `RuntimeRequestMeta` per server untuk `ForgeHttpApp`.

Hasil benchmark terverifikasi (`benchmarks/RESULTS.md`):
- **Node.js `v22.23.5`:** **#1 tercepat** di **ketiga microbenchmark in-process `app.fetch`** (`317,446 ops/sec` Static JSON — `2.42x` Hono & `20.9x` Fastify; `254,577 ops/sec` 5-Middleware — `2.61x` Hono; `53,646 ops/sec` Zod POST — `1.24x` Hono), **#1 pada 3 dari 4 skenario Live HTTP** (`3,867.36 req/s` Static JSON, `3,877.08 req/s` Param+Query, `3,977.83 req/s` 5-Middleware; mengungguli Hono di keempat skenario Live HTTP), serta **#1 Cold Startup** (`61.01 ms`).
- **Bun `1.4.4`:** **#1 tercepat** di **ketiga microbenchmark in-process `app.fetch`** (`721,724 ops/sec` Static JSON — `1.37x` Hono & `16.2x` Fastify; `446,581 ops/sec` 5-Middleware — `2.18x` Hono; `244,320 ops/sec` Zod POST — `1.14x` Hono), **#1 Live HTTP** pada Param+Query (`7,862.83 req/s`) dan 5-Middleware (`8,216.07 req/s`, `+17.3%` atas Hono), mengungguli Fastify di keempat skenario Live HTTP, cold startup **`11.08 ms`** (`10.1x` lebih cepat dari Fastify), serta **penggunaan memori paling hemat** di Bun (`185.72 MB` idle / `193.60 MB` loaded RSS, `9.74 MB` heap).

