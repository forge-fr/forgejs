# @forge-fr/testing

In-process testing utilities for **ForgeJS** applications running identically on Node.js and Bun.

## Features

- **`MemoryAdapter`**: Implements `@forge-fr/http`'s `HttpRuntimeAdapter` in-process without binding OS ports.
- **`createTestClient(app)`**: Ergonomic HTTP client (`get`, `post`, `put`, `patch`, `delete`, `options`, `head`) with query serialization, JSON body helpers, multi-value `Set-Cookie` inspection, and automatic kernel startup/disposal.
- **`overrideProvider(app, provider)`**: Clean DI provider override helper for isolating services in tests.
- **`runHttpAdapterContractSuite()`**: Shared 8-case live HTTP adapter contract suite for verifying Node.js and Bun runtime adapters identically.
- **`createPluginTestHarness(options)`**: Isolated plugin testing harness with dependency wiring, Standard Schema config validation, strict `resolveExport()` verification, and `health()` inspection.

## Usage

```ts
import { createHttpApp } from '@forge-fr/http';
import { createTestClient } from '@forge-fr/testing';

const app = createHttpApp();
app.get('/health', (ctx) => ctx.json({ ok: true }));

const client = createTestClient(app);
const res = await client.get('/health');
console.log(res.status, await res.json());
await client.close();
```

## License

MIT
