# @forge-fr/core

> 7-stage application kernel, typed dependency injection container, encapsulated modules, SemVer capability-scoped plugin runtime, errors, secrets, config, events, hooks, and health checks.

- **Version**: v1.0.0-rc.1
- **Layer**: Framework Core
- **Category**: core
- **Tarball**: 50.5 kB (56 files)
- **Internal deps**: none
- **Runtime deps**: zero runtime dependencies
- **Peer deps**: none
- **HTML URL**: https://github.com/forge-fr/forgejs/api/core
- **Markdown URL**: https://github.com/forge-fr/forgejs/api/core.md

## Installation

```bash
npm install @forge-fr/core
```

## Runtime & Error Semantics

- **Runtime**: Zero third-party runtime dependencies and zero node:* or Bun globals. Runs identically on Node.js >=22.18.0, Bun >=1.4.0, and WinterCG Edge.
- **Errors**: All framework errors inherit from ForgeError. Production serialization strips details when expose is false (default for 5xx errors).

## Usage Example

```ts
import { createKernel, createToken, defineModule, secret } from '@forge-fr/core';

const ApiKeyToken = createToken<string>('ApiKey');

const ConfigModule = defineModule({
  name: 'app-config',
  providers: [
    { token: ApiKeyToken, scope: 'singleton', useValue: secret(process.env.API_KEY ?? 'dev').reveal() },
  ],
  exports: [ApiKeyToken],
});

const kernel = createKernel({ modules: [ConfigModule] });
await kernel.start();
```

## Public Exports

### Application Kernel

- **Values**: `createKernel`, `KernelConfigToken`, `KernelEventsToken`, `KernelLoggerToken`, `LifecycleError`
- **Types**: `AnyForgePlugin`, `ApplicationKernel`, `KernelEventMap`, `KernelHookContext`, `KernelHooks`, `KernelOptions`, `KernelPluginInput`, `KernelState`, `LifecycleErrorEvent`, `LifecycleStage`, `LifecycleStageEvent`

### Dependency Injection

- **Values**: `createContainer`, `createToken`, `isToken`, `CircularDependencyError`, `ContainerDisposedError`, `ProviderNotFoundError`, `ScopeViolationError`
- **Types**: `AliasProvider`, `ClassProvider`, `Container`, `DependencyResolver`, `Disposer`, `FactoryProvider`, `InjectableConstructor`, `InjectionToken`, `ProviderDefinition`, `ProviderScope`, `RegisterOptions`, `ValueProvider`

### Modules

- **Values**: `defineModule`, `createModuleRegistry`, `CircularModuleDependencyError`, `ModuleConfigurationError`, `ProviderNotVisibleError`
- **Types**: `AnyProviderDefinition`, `ForgeModule`, `ModuleConfigureContext`, `ModuleDefinition`, `ModuleLifecycleContext`, `ModuleRegistry`, `ModuleRegistryOptions`

### Plugins & SemVer

- **Values**: `FORGE_CORE_VERSION`, `definePlugin`, `createPluginRegistry`, `createPluginContext`, `validatePluginConfig`, `parseSemVer`, `isValidSemVer`, `compareSemVer`, `isValidSemVerRange`, `satisfiesRange`, `CircularPluginDependencyError`, `PluginCapabilityError`, `PluginCompatibilityError`, `PluginConfigError`, `PluginConflictError`, `PluginDefinitionError`, `PluginDependencyError`, `PluginEncapsulationError`, `PluginLifecycleError`
- **Types**: `ForgePlugin`, `ForgePluginDefinition`, `PluginCapability`, `PluginConfigIssue`, `PluginContext`, `PluginContextRuntimeBridge`, `PluginDependencySpec`, `PluginHookEvent`, `PluginHookStage`, `PluginProviderRegisterOptions`, `PluginRegistry`, `PluginRegistryOptions`, `RegisteredPlugin`, `ResolvedPluginEntry`, `SemVer`, `StandardSchemaIssueLike`, `StandardSchemaLike`

### Errors & Secrets

- **Values**: `ForgeError`, `ValidationError`, `UnauthorizedError`, `ForbiddenError`, `NotFoundError`, `ConflictError`, `ConfigurationError`, `InternalError`, `isForgeError`, `normalizeError`, `secret`, `isSecretValue`, `REDACTED_PLACEHOLDER`
- **Types**: `ForgeErrorOptions`, `PublicErrorBody`, `PublicErrorSerializationOptions`, `SecretValue`

### Configuration, Logging, Events, Hooks & Health

- **Values**: `createConfigManager`, `createConsoleLogger`, `createNoopLogger`, `createEventDispatcher`, `createHookRegistry`, `createHealthRegistry`
- **Types**: `ConfigManager`, `ConfigManagerOptions`, `ConsoleLoggerOptions`, `ForgeLogger`, `LogContext`, `LogEntry`, `LogLevel`, `LogSink`, `EventDispatcher`, `EventDispatcherOptions`, `EventErrorStrategy`, `EventHandler`, `EventMap`, `HookEntryInfo`, `HookHandler`, `HookMap`, `HookRegistrationOptions`, `HookRegistry`, `HealthCheckFn`, `HealthCheckResult`, `HealthRegistry`, `HealthReport`, `HealthStatus`
