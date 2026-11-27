# Changelog — @forge-fr/core

## [0.1.0] — Phase 3 Complete (2026-11-25)

### Added (Phase 3 — Milestone 3.2: Capability Enforcement, Config Validation, Encapsulation & Lifecycle Orchestration)
- Zero-dependency `HealthRegistry` (`createHealthRegistry`, exposed on `kernel.health`) aggregating named async health checks (`ok` | `degraded` | `unhealthy`).
- Frozen capability-scoped `PluginContext` (`createPluginContext`) enforcing declared capabilities (`di:register`, `di:resolve`, `config:read`, `events:emit`, `events:listen`, `hooks:register`, `health:register`) via `PluginCapabilityError` without leaking raw kernel internals.
- Standard Schema v1 `configSchema` validation (`validatePluginConfig`) at the `configure` stage (`PluginConfigError`) with full `TConfigInput` vs `TConfig` TypeScript inference (works natively with Zod v4, Valibot v1, and custom async schemas).
- Strict plugin provider encapsulation (`PluginEncapsulationError`): plugin providers are private by default unless explicitly exported (`{ export: true }` or `exportProvider()`), accessible only to declaring dependents and application modules.
- Full plugin lifecycle orchestration (`register → initialize → onReady → onShutdown`) in `ApplicationKernel` with reverse-order shutdown, automatic listener/hook/health-check cleanup, and best-effort rollback on boot failure.

### Added (Phase 3 — Milestone 3.1: Plugin Contract & Dependency Resolver)
- Zero-dependency SemVer 2.0.0 engine (`parseSemVer`, `isValidSemVer`, `compareSemVer`, `isValidSemVerRange`, `satisfiesRange`) with caret, tilde, comparator, hyphen, wildcard, compound AND/OR, and prerelease-isolation rules.
- Declarative `ForgePlugin<TConfig>` contract and `definePlugin()` validator rejecting malformed names, prototype-pollution keys, invalid SemVer/ranges, self-dependencies, and contradictory metadata.
- `createPluginRegistry()` and `ApplicationKernel` integration (`kernel.plugin()`, `kernel.removePlugin()`, `kernel.plugins`, `kernel.forgeVersion`) with `forgeVersion` & dependency SemVer checks (`PluginCompatibilityError`), duplicate & bidirectional conflict detection (`PluginConflictError`), missing required dependency errors (`PluginDependencyError`), optional dependency tracking, deterministic topological resolution with cycle traces (`CircularPluginDependencyError`), and pre-start removal locked on `start()`.

### Added (Milestone 1.3 — Module Registry & Application Kernel Lifecycle)
- Encapsulated Module Registry (`defineModule`, `createModuleRegistry`) enforcing strict private vs exported provider visibility (`ProviderNotVisibleError`), non-transitive encapsulation unless explicitly re-exported, diamond dependency deduplication, circular module detection (`CircularModuleDependencyError`), and deterministic topological initialization order.
- 7-Stage Application Kernel (`createKernel`) implementing `configure → register → initialize → start → ready → shutdown → dispose`, built-in global tokens (`KernelConfigToken`, `KernelLoggerToken`, `KernelEventsToken`), strict transition guards (`LifecycleError`), boot failure rollback (reverse shutdown of already-initialized modules + container disposal), and error-resilient reverse graceful shutdown.

### Added (Milestone 1.2 — Dependency Injection Container)
- Branded typed injection tokens (`createToken<T>`, `isToken`).
- Composition-first DI container (`createContainer`) supporting `useValue`, `useFactory`, `useClass`, and `useExisting` alias providers.
- Scopes: `singleton`, `transient`, and isolated `request` child scopes (`createScope()`), captive-dependency prevention (`ScopeViolationError`), circular dependency detection (`CircularDependencyError`), and LIFO async disposal.

### Added (Milestone 1.1 — Core Primitives)
- `ForgeError` hierarchy and production-safe error normalization/serialization (`toPublicJSON`, `normalizeError`, `isForgeError`).
- `ForgeLogger` contract, `createConsoleLogger` with recursive sensitive-key redaction, and `createNoopLogger`.
- `ConfigManager` with deep immutability, prototype-pollution rejection, boot-time schema validation, and masked `SecretValue` (`secret()`).
- Typed `EventDispatcher` (`fail-fast`, `collect`, `isolate`) and priority-ordered `HookRegistry`.
