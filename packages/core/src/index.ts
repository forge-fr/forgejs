export {
  ConfigurationError,
  ConflictError,
  ForbiddenError,
  ForgeError,
  InternalError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
  isForgeError,
  normalizeError,
  type ForgeErrorOptions,
  type PublicErrorBody,
  type PublicErrorSerializationOptions,
} from './errors.js';

export {
  REDACTED_PLACEHOLDER,
  isSecretValue,
  secret,
  type SecretValue,
} from './secret.js';

export {
  createConsoleLogger,
  createNoopLogger,
  type ConsoleLoggerOptions,
  type ForgeLogger,
  type LogContext,
  type LogEntry,
  type LogLevel,
  type LogSink,
} from './logger.js';

export {
  createConfigManager,
  type ConfigManager,
  type ConfigManagerOptions,
} from './config.js';

export {
  createEventDispatcher,
  type EventDispatcher,
  type EventDispatcherOptions,
  type EventErrorStrategy,
  type EventHandler,
  type EventMap,
} from './events.js';

export {
  createHookRegistry,
  type HookEntryInfo,
  type HookHandler,
  type HookMap,
  type HookRegistrationOptions,
  type HookRegistry,
} from './hooks.js';

export {
  CircularDependencyError,
  ContainerDisposedError,
  ProviderNotFoundError,
  ScopeViolationError,
  createContainer,
  createToken,
  isToken,
  type AliasProvider,
  type ClassProvider,
  type Container,
  type DependencyResolver,
  type Disposer,
  type FactoryProvider,
  type InjectableConstructor,
  type InjectionToken,
  type ProviderDefinition,
  type ProviderScope,
  type RegisterOptions,
  type ValueProvider,
} from './di.js';

export {
  CircularModuleDependencyError,
  ModuleConfigurationError,
  ProviderNotVisibleError,
  createModuleRegistry,
  defineModule,
  type AnyProviderDefinition,
  type ForgeModule,
  type ModuleConfigureContext,
  type ModuleDefinition,
  type ModuleLifecycleContext,
  type ModuleRegistry,
  type ModuleRegistryOptions,
} from './modules.js';

export {
  createHealthRegistry,
  type HealthCheckFn,
  type HealthCheckResult,
  type HealthRegistry,
  type HealthReport,
  type HealthStatus,
} from './health.js';

export {
  compareSemVer,
  isValidSemVer,
  isValidSemVerRange,
  parseSemVer,
  satisfiesRange,
  type SemVer,
} from './semver.js';

export {
  CircularPluginDependencyError,
  FORGE_CORE_VERSION,
  PluginCapabilityError,
  PluginCompatibilityError,
  PluginConfigError,
  PluginConflictError,
  PluginDefinitionError,
  PluginDependencyError,
  PluginEncapsulationError,
  PluginLifecycleError,
  createPluginContext,
  createPluginRegistry,
  definePlugin,
  validatePluginConfig,
  type ForgePlugin,
  type ForgePluginDefinition,
  type PluginCapability,
  type PluginConfigIssue,
  type PluginContext,
  type PluginContextRuntimeBridge,
  type PluginDependencySpec,
  type PluginHookEvent,
  type PluginHookStage,
  type PluginProviderRegisterOptions,
  type PluginRegistry,
  type PluginRegistryOptions,
  type RegisteredPlugin,
  type ResolvedPluginEntry,
  type StandardSchemaIssueLike,
  type StandardSchemaLike,
} from './plugins.js';

export {
  KernelConfigToken,
  KernelEventsToken,
  KernelLoggerToken,
  LifecycleError,
  createKernel,
  type AnyForgePlugin,
  type ApplicationKernel,
  type KernelEventMap,
  type KernelHookContext,
  type KernelHooks,
  type KernelOptions,
  type KernelPluginInput,
  type KernelState,
  type LifecycleErrorEvent,
  type LifecycleStage,
  type LifecycleStageEvent,
} from './kernel.js';
