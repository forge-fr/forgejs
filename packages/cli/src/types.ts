export type CliRuntimeTarget = 'auto' | 'node' | 'bun';

export type ProjectRuntimeTarget = 'node' | 'bun' | 'edge';

export type ProjectTemplateKind = 'minimal' | 'api' | 'modular';

export type GeneratorArtifactKind =
  | 'module'
  | 'controller'
  | 'service'
  | 'repository'
  | 'schema'
  | 'resource';

export type GeneratorNamingMode = 'plural' | 'singular' | 'exact';

export interface ForgeProjectConfig {
  readonly modulesDir?: string;
  readonly naming?: GeneratorNamingMode;
  readonly crud?: boolean;
}

export interface GeneratorOptions {
  /** Base directory for generated modules relative to project root (e.g., `'src/modules'` or `'src'`). */
  readonly modulesDir?: string;
  /** Naming convention for module directories and filenames. Default: `'plural'` for multi-file bundles, `'exact'` for legacy single-file calls. */
  readonly naming?: GeneratorNamingMode;
  /** Include full CRUD operations in generated schema, repository, service, and controller. Default: `true`. */
  readonly crud?: boolean;
  /** When generating `module`, emit only `<name>.module.ts` instead of the full 5-file module bundle. Default: `false`. */
  readonly singleFile?: boolean;
  /** Whether the module bundle includes a repository provider (`<name>.repository.ts`). Default: `true`. */
  readonly includeRepository?: boolean;
  /** Whether the module bundle includes a schema file (`<name>.schema.ts`). Default: `true`. */
  readonly includeSchema?: boolean;
  /** Whether the module bundle includes a controller file (`<name>.controller.ts`). Default: `true`. */
  readonly includeController?: boolean;
}

export interface ParsedCliArgs {
  readonly command: string;
  readonly positionals: readonly string[];
  readonly flags: ReadonlySet<string>;
  readonly options: Readonly<Record<string, string>>;
}

export interface NormalizedSymbolName {
  readonly kebab: string;
  readonly pascal: string;
  readonly camel: string;
}

export interface InflectedSymbolName extends NormalizedSymbolName {
  readonly singularKebab: string;
  readonly singularPascal: string;
  readonly singularCamel: string;
  readonly pluralKebab: string;
  readonly pluralPascal: string;
  readonly pluralCamel: string;
}

export interface GeneratedFileEntry {
  readonly relativePath: string;
  readonly content: string;
}

export interface SpawnCommandOptions {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface SpawnCommandResult {
  readonly exitCode: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

export type CliSpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnCommandOptions,
) => Promise<SpawnCommandResult>;

export type CliPromptFn = (question: string, defaultValue?: string) => Promise<string>;

export interface CliExecutionContext {
  readonly cwd?: string;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
  readonly spawnCommand?: CliSpawnFn;
  readonly probeCommand?: CliSpawnFn;
  readonly prompt?: CliPromptFn;
  readonly packageVersion?: string;
}

export interface CliResult {
  readonly exitCode: number;
  readonly command: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly data?: unknown;
}

export interface DoctorCheckResult {
  readonly id: string;
  readonly label: string;
  readonly status: 'ok' | 'warn' | 'fail';
  readonly message: string;
}

export interface DoctorReport {
  readonly ok: boolean;
  readonly cwd: string;
  readonly runtime: {
    readonly activeRuntime: 'node' | 'bun';
    readonly nodeVersion: string;
    readonly bunVersion: string | null;
  };
  readonly checks: readonly DoctorCheckResult[];
}
