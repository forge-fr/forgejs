# @forge-fr/cli

> Zero-dependency forge CLI to scaffold new apps, generate full CRUD resources/modules/schemas/repositories/services/controllers, add official plugins, and run doctor checks.

- **Version**: v1.0.0
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
# Add once to .npmrc: @forge-fr:registry=https://npm.pkg.github.com
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

- **Values**: `runCli`, `parseCliArgs`, `HELP_TEXT`, `OFFICIAL_FORGE_PLUGINS`, `inflectSymbolName`, `pluralizeWord`, `singularizeWord`, `resolvePluginPackageSpec`, `resolveSafeTargetPath`, `sanitizeJsonObject`, `validateProjectName`, `validateSymbolName`, `buildProjectTemplateFiles`, `generateArtifactFiles`, `generateCodeArtifacts`, `generateModuleBundle`, `injectModuleRegistrationInAppSource`, `renderControllerTemplate`, `renderModuleTemplate`, `renderRepositoryTemplate`, `renderSchemaTemplate`, `renderServiceTemplate`, `resolveGeneratorContext`, `loadForgeProjectConfig`, `resolveGeneratorKind`, `defaultSpawnCommand`, `executeNewCommand`, `executeGenerateCommand`, `executePluginCommand`, `executeDoctorCommand`, `executeLifecycleCommand`, `CliError`
- **Types**: `CliErrorCode`, `CliExecutionContext`, `CliPromptFn`, `CliResult`, `CliRuntimeTarget`, `CliSpawnFn`, `DoctorCheckResult`, `DoctorReport`, `ForgeProjectConfig`, `GeneratedFileEntry`, `GeneratorArtifactKind`, `GeneratorNamingMode`, `GeneratorOptions`, `InflectedSymbolName`, `NormalizedSymbolName`, `ParsedCliArgs`, `ProjectRuntimeTarget`, `ProjectTemplateKind`, `ProjectTemplateOptions`, `ResolvedGeneratorContext`, `SpawnCommandOptions`, `SpawnCommandResult`
