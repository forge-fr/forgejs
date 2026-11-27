export { CliError, type CliErrorCode } from './errors.js';
export { parseCliArgs } from './argv.js';
export {
  OFFICIAL_FORGE_PLUGINS,
  resolvePluginPackageSpec,
  resolveSafeTargetPath,
  sanitizeJsonObject,
  validateProjectName,
  validateSymbolName,
} from './safety.js';
export { buildProjectTemplateFiles, generateArtifactFiles, type ProjectTemplateOptions } from './templates.js';
export {
  HELP_TEXT,
  defaultSpawnCommand,
  executeDoctorCommand,
  executeGenerateCommand,
  executeLifecycleCommand,
  executeNewCommand,
  executePluginCommand,
} from './commands.js';
export { runCli } from './runner.js';
export type {
  CliExecutionContext,
  CliResult,
  CliRuntimeTarget,
  CliSpawnFn,
  DoctorCheckResult,
  DoctorReport,
  GeneratedFileEntry,
  GeneratorArtifactKind,
  NormalizedSymbolName,
  ParsedCliArgs,
  ProjectTemplateKind,
  SpawnCommandOptions,
  SpawnCommandResult,
} from './types.js';
