# @forge-fr/cli

Official cross-runtime command-line interface for **ForgeJS** running identically on **Node.js (>=22.18.0)** and **Bun (>=1.4)**.

## Commands

- `forge new <project-name> [--template minimal|api|modular] [--runtime node|bun] [--dir <path>]`
- `forge generate <module|controller|service> <name> [--dir <path>]` (alias: `forge g`)
- `forge plugin add <plugin-name> [--dir <path>]`
- `forge dev [--runtime auto|node|bun] [--watch] [--dir <path>]`
- `forge build [--dir <path>]`
- `forge start [--runtime auto|node|bun] [--dir <path>]`
- `forge test [--runtime auto|node|bun] [--dir <path>]`
- `forge doctor [--json] [--dir <path>]`
