# Adapter Development

> Build custom runtime, database, cache, queue, or storage adapters and test them with the shared ForgeJS contract suites.

- **Section**: Plugins & Extensions
- **Packages**: @forge-fr/http, @forge-fr/database, @forge-fr/testing
- **Version**: v1.0.0
- **Updated**: 2026-11-27
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/plugins/adapter-development
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/plugins/adapter-development.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/architecture.md

## Verify adapters with shared contract tests

Every official HTTP and WebSocket adapter passes the same shared test suites from @forge-fr/testing: runHttpAdapterContractSuite() and runWebSocketContractSuite(). You can run them against your own adapter too.

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

- Implement connect(), disconnect(), ping(), transaction(fn, opts), and clear connection states.
- Map raw database errors to @forge-fr/database ForgeError classes with expose: false.
- Wrap your adapter with createDatabasePlugin() to wire DI tokens and health checks automatically.
