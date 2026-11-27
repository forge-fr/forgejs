# @forge-fr/core

Runtime-agnostic core engine for the **ForgeJS** TypeScript backend framework (native support for Node.js `>=22.18.0` and Bun `>=1.4.0`).

## Public Modules

- **`ForgeError` hierarchy:** Typed domain/HTTP error classes (`ConfigurationError`, `ValidationError`, `NotFoundError`, `ConflictError`, `UnauthorizedError`, `ForbiddenError`, `InternalError`) with production-safe serialization (`toPublicJSON`).
- **`ForgeLogger` & default JSON logger:** Structured logger interface with level filtering, immutable child bindings, circular reference protection, and automatic sensitive key redaction.
- **`ConfigManager` & `SecretValue`:** Deeply immutable configuration manager with schema validation, prototype-pollution rejection, and masked secrets (`secret()`).
- **`EventDispatcher`:** Strictly typed async/sync event bus with configurable error handling (`fail-fast`, `collect`, `isolate`) and snapshot iteration safety.
- **`HookRegistry`:** Priority-ordered deterministic hook pipeline supporting sequential waterfall transforms and parallel hook dispatch.
- **Dependency Injection Container (`createContainer`, `createToken`):** Composition-first DI with `useValue`, `useFactory`, `useClass` (explicit or static `inject`), and `useExisting` aliases; `singleton`, `transient`, and `request` scopes; captive-dependency prevention; circular dependency detection; and LIFO async disposal.
- **Encapsulated Module Registry (`defineModule`, `createModuleRegistry`):** Strict private/exported provider visibility, non-transitive encapsulation unless re-exported, diamond dependency deduplication, circular module detection, and deterministic topological ordering.
- **Zero-Dep SemVer 2.0.0 Engine (`parseSemVer`, `compareSemVer`, `satisfiesRange`, `isValidSemVer`, `isValidSemVerRange`):** Strict SemVer parsing, precedence ordering, and caret/tilde/hyphen/wildcard/compound range matching with prerelease isolation.
- **Plugin System (`definePlugin`, `createPluginRegistry`, `createPluginContext`, `validatePluginConfig`):** Declarative `ForgePlugin<TConfig, TConfigInput>` contract, `forgeVersion` & dependency SemVer verification, bidirectional conflict detection, optional dependencies, deterministic topological DAG ordering with cycle traces, pre-start `removePlugin()`, frozen capability-scoped `PluginContext` (`PluginCapabilityError`), Standard Schema v1 `configSchema` validation at `configure` (`PluginConfigError`), strict private vs exported provider encapsulation (`PluginEncapsulationError`), and reverse-order shutdown & rollback cleanup.
- **Health Check Registry (`createHealthRegistry`):** Zero-dependency readiness/liveness registry (`kernel.health`) aggregating named async health checks (`ok` | `degraded` | `unhealthy`) and safely catching check failures.
- **7-Stage Application Kernel (`createKernel`):** Deterministic `configure → register → initialize → start → ready → shutdown → dispose` lifecycle orchestrating modules and plugins with boot failure rollback, reverse-order graceful shutdown, idempotent disposal, and request scope creation.

## Guarantees

- Zero external runtime dependencies.
- Zero `node:*` or `Bun` runtime imports.
- Pure ESM with strict TypeScript declarations (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`).
