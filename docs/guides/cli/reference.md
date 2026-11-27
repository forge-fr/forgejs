# CLI Reference (@forge-fr/cli)

> Complete reference for all 10 verified forge CLI commands, flags, templates, expected output, and error codes from packages/cli/src/commands.ts.

- **Section**: CLI Reference
- **Packages**: @forge-fr/cli
- **Version**: v1.0.0-rc.1
- **Updated**: 2026-11-26
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/cli/reference
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/cli/reference.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/infrastructure-and-cli.md

## All 10 verified commands

@forge-fr/cli ships the cross-runtime forge binary (Node.js >=22.18 and Bun >=1.4) with zero third-party runtime dependencies, shell: false process execution, and prototype-safe package.json editing.

| Command | Usage | Behavior |
| --- | --- | --- |
| forge new | forge new <name> [--template minimal\|api\|modular] [--runtime node\|bun\|edge] | Scaffold a strict-ESM TypeScript ForgeJS application with runtime adapter setup. |
| forge generate | forge generate\|g <module\|controller\|service> <name> | Generate typed module, controller, or service boilerplate following layered boundaries. |
| forge plugin add | forge plugin add <plugin> | Register an official @forge-fr/* plugin into your project configuration safely. |
| forge dev | forge dev [--watch] [--runtime node\|bun] | Start the development server on Node.js or Bun with optional file watch mode. |
| forge build | forge build | Compile TypeScript sources into production ESM artifacts. |
| forge start | forge start | Launch the compiled production application entrypoint. |
| forge test | forge test | Run the project test suite via the configured test runner. |
| forge doctor | forge doctor [--json] | Inspect runtime versions, TypeScript configuration, ESM mode, and workspace health. |
| forge help | forge help | Display CLI usage instructions and available flags. |
| forge version | forge version | Print the installed @forge-fr/cli version. |

## Command options & error codes

| Command | Supported Options / Flags | Error Codes |
| --- | --- | --- |
| forge new <name> | --template <api\|modular>, --runtime <auto\|node\|bun\|edge>, --port <1..65535>, --dir <path>, --dry-run, --force | CLI_INVALID_ARGUMENT, CLI_FILE_EXISTS |
| forge generate <type> <name> | type: module \| controller \| service (alias: g); --dir <path>, --dry-run, --force | CLI_INVALID_ARGUMENT, CLI_FILE_EXISTS |
| forge plugin add <plugin> | --dir <path>, --dry-run (sanitizes & sorts package.json dependencies) | CLI_INVALID_ARGUMENT, CLI_EXECUTION_FAILED |
| forge dev / build / start / test | --runtime <auto\|node\|bun>, --watch (dev), --dir <path> | CLI_INVALID_ARGUMENT |
| forge doctor | --json (machine-readable DoctorReport), --dir <path> | Exits 1 if Node.js < 22 |

## Common CLI workflows & expected output

**File: `terminal`**

```bash
# 1. Scaffold a modular backend
npx @forge-fr/cli@next new payments-api --template modular --runtime node
# => Created ForgeJS project "payments-api" at ./payments-api

# 2. Generate typed feature artifacts (alias: forge g)
forge generate module webhooks
forge generate controller webhooks
forge generate service webhooks

# 3. Register an official plugin & inspect workspace health
forge plugin add security
forge doctor --json
```
