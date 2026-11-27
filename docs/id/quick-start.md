# Panduan Memulai Cepat ForgeJS

ForgeJS adalah framework backend TypeScript ESM murni yang berjalan identik di **Node.js (`>=22.18.0`)** dan **Bun (`>=1.4.0`)** tanpa perbedaan perilaku aplikasi.

## 1. API Sederhana untuk Layanan Ringan

Anda bisa memulai dalam hitungan baris kode dengan `@forge-fr/http` serta melakukan pengujian in-process tanpa membuka port TCP via `@forge-fr/testing`:

```ts forge-example
import assert from 'node:assert/strict';
import { createHttpApp } from '@forge-fr/http';
import { createTestClient } from '@forge-fr/testing';

const app = createHttpApp();

app.get('/sapa/:nama', (ctx) =>
  ctx.json({
    pesan: `Halo, ${ctx.params['nama'] ?? 'teman'}!`,
    runtime: 'forgejs',
  }),
);

const client = createTestClient(app);
const res = await client.get('/sapa/Budi');
assert.equal(res.status, 200);
assert.deepEqual(await res.json(), {
  pesan: 'Halo, Budi!',
  runtime: 'forgejs',
});

await client.close();
```

## 2. Validasi Input Tipe-Aman (`@forge-fr/validation`)

Gunakan `validatedHandler` agar parameter URL dan JSON body tervalidasi otomatis dengan Zod v4 atau Valibot v1 serta terlindungi dari kunci prototipe berbahaya:

```ts forge-example
import assert from 'node:assert/strict';
import { createHttpApp } from '@forge-fr/http';
import { createTestClient } from '@forge-fr/testing';
import { validatedHandler } from '@forge-fr/validation';
import { z } from 'zod';

const app = createHttpApp();

app.post(
  '/produk',
  validatedHandler(
    {
      body: z.object({
        nama: z.string().min(2),
        stok: z.number().int().nonnegative(),
      }),
    },
    (ctx, input) => ctx.json({ tersimpan: true, data: input.body }, { status: 201 }),
  ),
);

const client = createTestClient(app);
const sukses = await client.post('/produk', {
  json: { nama: 'Keyboard', stok: 12 },
});
assert.equal(sukses.status, 201);
assert.deepEqual(await sukses.json(), {
  tersimpan: true,
  data: { nama: 'Keyboard', stok: 12 },
});

await client.close();
```
