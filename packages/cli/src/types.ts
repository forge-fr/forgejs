export type CliRuntimeTarget = 'auto' | 'node' | 'bun';

export type ProjectRuntimeTarget = 'node' | 'bun' | 'edge';

export type ProjectTemplateKind = 'minimal' | 'api' | 'modular';

export type GeneratorArtifactKind = 'module' | 'controller' | 'service';

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

export interface CliExecutionContext {
  readonly cwd?: string;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
  readonly spawnCommand?: CliSpawnFn;
  readonly probeCommand?: CliSpawnFn;
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
