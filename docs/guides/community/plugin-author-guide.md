# Plugin Author Guide

> Checklist for publishing clean, ESM-only ForgeJS plugins with safe permissions, peer dependencies, and verified tarballs.

- **Section**: Community & Contributing
- **Packages**: @forge-fr/core, @forge-fr/testing
- **Version**: v1.0.0
- **Updated**: 2026-11-27
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/community/plugin-author-guide
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/community/plugin-author-guide.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/PACKAGE_STRATEGY.md

## Checklist before publishing a plugin

- Request only the capabilities your plugin really needs in definePlugin(), and validate options with a configSchema.
- Publish pure ESM with an explicit exports map in package.json.
- List large client libraries (like ioredis or @prisma/client) as optional peerDependencies using small structural types.
- Test startup, exports, health checks, and teardown with createPluginTestHarness(), and check npm pack --dry-run.

## Example package.json exports map

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
    "@forge-fr/core": "^1.0.0"
  }
}
```
