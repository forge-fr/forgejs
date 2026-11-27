# Release & Versioning

> SemVer 2.0.0 versioning across all 20 @forge-fr/* packages, v1.0.0-rc.2 changelog, and GitHub Packages / npm OIDC Trusted Publishing workflow.

- **Section**: Community & Contributing
- **Packages**: @forge-fr/core, @forge-fr/http, @forge-fr/edge, @forge-fr/logger
- **Version**: v1.0.0-rc.2
- **Updated**: 2026-11-27
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/community/release-and-versioning
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/community/release-and-versioning.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/CHANGELOG.md

## What changed in v1.0.0-rc.2 (2026-11-27)

v1.0.0-rc.2 fixes Cloudflare Workers / Edge production execution, brings Edge parity to Pino MemoryLogSink logging, resolves native Node.js 22 production startup, and upgrades CI workflows to Node 24 actions.

- @forge-fr/http & @forge-fr/edge: Always materialize genuine native Response instances on Cloudflare Workers (workerd), Deno, and Bun (plus exported toNativeResponse() helper), resolving HTTP 500 WebIDL errors on Edge isolates.
- @forge-fr/logger: Added browser.write forwarding in createPinoLogger() so MemoryLogSink captures structured PII-redacted logs under pino/browser.js on Edge runtimes.
- Playground & Production Server: Added Edge-safe inline webhook queue draining (no cross-request setTimeout loops), portable WebCrypto JWT secret fallback, and explicit .ts extensions for native node server.ts production execution.
- CI & Packaging: Synchronized all 20 @forge-fr/* packages and @forge-fr/cli templates to 1.0.0-rc.2, added workspace paths fallback in tsconfig.base.json, and upgraded GitHub Actions to checkout@v6, setup-node@v6, upload-artifact@v6, and wrangler-action@v4.

## OIDC Trusted Publishing & topological order

.github/workflows/release.yml and .github/workflows/github-packages.yml publish all 20 @forge-fr/* packages in strict topological order (core → router → http → ... → cli) with provenance support.

| Release Property | Verified Value |
| --- | --- |
| Current Workspace Version | 1.0.0-rc.2 (synchronized across all 20 packages) |
| License | MIT |
| Tarball Verification | 20/20 packages verified via npm pack + isolated Node 22 & Bun 1.4 consumer installs |
| Edge & Production Verification | Native Response prototype verified on bundled Cloudflare Worker + NODE_ENV=production node server.ts |
