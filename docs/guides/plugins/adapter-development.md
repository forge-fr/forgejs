# Adapter Development

> Implement custom HTTP runtime, database, cache, queue, or storage adapters and verify them against ForgeJS contract suites.

- **Section**: Plugins & Extensions
- **Packages**: @forge-fr/http, @forge-fr/database, @forge-fr/testing
- **Version**: v1.0.0-rc.2
- **Updated**: 2026-11-26
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/plugins/adapter-development
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/plugins/adapter-development.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/architecture.md

## Shared adapter contract verification

Every official HTTP and WebSocket adapter passes the exact same behavioral contract suites exported by @forge-fr/testing: runHttpAdapterContractSuite() and runWebSocketContractSuite().

**File: `tests/custom-adapter.contract.test.ts`**

```ts
import { runHttpAdapterContractSuite } from '@forge-fr/testing';
import { createMyRuntimeAdapter } from '../src/my-adapter.js';

const report = await runHttpAdapterContractSuite({
  name: 'my-custom-runtime',
  createAdapter: () => createMyRuntimeAdapter(),
});

if (!report.passed) {
  throw new Error(`Adapter contract failed: ${JSON.stringify(report.results)}`);
}
```

## Building custom DatabaseAdapter drivers

- Implement connect(), disconnect(), ping(), transaction(fn, opts), and state transitions cleanly.
- Normalize driver-specific error codes into @forge-fr/database ForgeError subclasses with expose: false.
- Wrap your adapter with createDatabasePlugin() to automatically register DI tokens and health probes.
