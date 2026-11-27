# Plugin Author Guide

> Checklist for publishing pure-ESM, capability-scoped third-party ForgeJS plugins with SemVer safety and clean npm pack tarballs.

- **Section**: Community & Contributing
- **Packages**: @forge-fr/core, @forge-fr/testing
- **Version**: v1.0.0-rc.1
- **Updated**: 2026-11-26
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/community/plugin-author-guide
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/community/plugin-author-guide.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/PACKAGE_STRATEGY.md

## Publication & hygiene checklist

- Declare minimum required capabilities in definePlugin() and validate config with Standard Schema v1.
- Ship pure ESM with strict exports map ("exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } }).
- Declare heavy client libraries (e.g., ioredis, @prisma/client) as optional peerDependencies using narrow duck-typed interfaces.
- Verify lifecycle, health probes, and teardown via createPluginTestHarness() and inspect npm pack --dry-run before publishing.

## Reference package.json exports map

**File: `package.json`**

```json
{
  "name": "forgejs-plugin-example",
  "version": "1.0.0",
  "type": "module",
  "sideEffects": false,
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "peerDependencies": {
    "@forge-fr/core": "^1.0.0-rc.1"
  }
}
```
