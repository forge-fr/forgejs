# @forge-fr/cli

> Official zero-dependency forge CLI for project scaffolding (minimal, api, modular), artifact generators, official plugin registration, dev/build/start/test orchestration, and doctor checks.

- **Version**: v1.0.0-rc.1
- **Layer**: Tooling / CLI
- **Category**: tooling
- **Tarball**: 20.5 kB (40 files)
- **Internal deps**: @forge-fr/core
- **Runtime deps**: zero runtime dependencies
- **Peer deps**: none
- **HTML URL**: https://github.com/forge-fr/forgejs/api/cli
- **Markdown URL**: https://github.com/forge-fr/forgejs/api/cli.md

## Installation

```bash
npm install @forge-fr/cli
```

## Runtime & Error Semantics

- **Runtime**: Zero third-party runtime dependencies (uses node:* built-ins). Exposes bin "forge" for scaffolding, generation, plugin registration, and diagnostics.
- **Errors**: Validates project/symbol names and blocks directory traversal via resolveSafeTargetPath and CliError.

## Usage Example

```ts
# Scaffold a modular backend
npx @forge-fr/cli@next new billing-api --template modular --runtime node

# Generate a typed feature module
forge generate module invoices

# Inspect runtime and ESM readiness
forge doctor --json
```

## Public Exports

### CLI Programmatic API & Safety Helpers

- **Values**: `runCli`, `parseCliArgs`, `HELP_TEXT`, `OFFICIAL_FORGE_PLUGINS`, `resolvePluginPackageSpec`, `resolveSafeTargetPath`, `sanitizeJsonObject`, `validateProjectName`, `validateSymbolName`, `buildProjectTemplateFiles`, `generateArtifactFiles`, `defaultSpawnCommand`, `executeNewCommand`, `executeGenerateCommand`, `executePluginCommand`, `executeDoctorCommand`, `executeLifecycleCommand`, `CliError`
- **Types**: `CliErrorCode`, `CliExecutionContext`, `CliResult`, `CliRuntimeTarget`, `CliSpawnFn`, `DoctorCheckResult`, `DoctorReport`, `GeneratedFileEntry`, `GeneratorArtifactKind`, `NormalizedSymbolName`, `ParsedCliArgs`, `ProjectTemplateKind`, `ProjectTemplateOptions`, `SpawnCommandOptions`, `SpawnCommandResult`
