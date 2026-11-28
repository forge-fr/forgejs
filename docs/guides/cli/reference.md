# CLI Reference (@forge-fr/cli)

> Complete guide to all 10 forge CLI commands, flags, starter templates, expected output, and error codes.

- **Section**: CLI Reference
- **Packages**: @forge-fr/cli
- **Version**: v1.0.0
- **Updated**: 2026-11-27
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/cli/reference
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/cli/reference.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/infrastructure-and-cli.md

## All 10 forge CLI commands

@forge-fr/cli provides the cross-runtime forge command (Node.js >= 22.18 and Bun >= 1.4) with zero third-party runtime dependencies, safe child-process spawning (shell: false), and safe package.json editing.

| Command | Usage | What It Does |
| --- | --- | --- |
| forge new | forge new <name> [--template minimal\|api\|modular] [--runtime node\|bun\|edge] | Create a new TypeScript ForgeJS project preconfigured for your chosen runtime. |
| forge generate | forge generate\|g <module\|resource\|schema\|repository\|service\|controller> <name> [--dry-run] [--dir <dir>] [--force] | Generate a full CRUD resource, feature module, schema, repository, service, or controller with collision protection. |
| forge plugin add | forge plugin add <plugin> | Add and register an official @forge-fr/* plugin in your project config. |
| forge dev | forge dev [--watch] [--runtime node\|bun] | Run the local dev server on Node.js or Bun with optional file watching. |
| forge build | forge build | Compile your TypeScript source files into a production ESM build. |
| forge start | forge start | Start the compiled production server. |
| forge test | forge test | Run your project test suite. |
| forge doctor | forge doctor [--json] | Check Node/Bun versions, TypeScript settings, ESM mode, and workspace health. |
| forge help | forge help | Show CLI help and available flags. |
| forge version | forge version | Print the installed @forge-fr/cli version. |

## Options & error codes

| Command | Common Flags | Error Codes |
| --- | --- | --- |
| forge new <name> | --template <api\|modular>, --runtime <auto\|node\|bun\|edge>, --port <1..65535>, --dir <path>, --dry-run, --force | CLI_INVALID_ARGUMENT, CLI_FILE_EXISTS |
| forge generate <type> <name> | type: module \| controller \| service (alias: g); --dir <path>, --dry-run, --force | CLI_INVALID_ARGUMENT, CLI_FILE_EXISTS |
| forge plugin add <plugin> | --dir <path>, --dry-run (adds and sorts package.json dependencies safely) | CLI_INVALID_ARGUMENT, CLI_EXECUTION_FAILED |
| forge dev / build / start / test | --runtime <auto\|node\|bun>, --watch (dev), --dir <path> | CLI_INVALID_ARGUMENT |
| forge doctor | --json (outputs JSON DoctorReport), --dir <path> | Exits 1 if Node.js < 22 |

## Everyday CLI workflow examples

**File: `terminal`**

```bash
# 1. Create a new modular backend project
npx @forge-fr/cli new payments-api --template modular --runtime node
# => Created ForgeJS project "payments-api" at ./payments-api

# 2. Generate files for a new feature (shortcut: forge g)
forge generate module webhooks
forge generate controller webhooks
forge generate service webhooks

# 3. Add an official plugin & check your setup
forge plugin add security
forge doctor --json
```
