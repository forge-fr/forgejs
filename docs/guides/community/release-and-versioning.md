# Release & Versioning

> SemVer 2.0.0 versioning across all 20 @forge-fr/* packages, v1.0.0-rc.1 status, and OIDC Trusted Publishing workflow.

- **Section**: Community & Contributing
- **Packages**: @forge-fr/core
- **Version**: v1.0.0-rc.1
- **Updated**: 2026-11-26
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/community/release-and-versioning
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/community/release-and-versioning.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/CHANGELOG.md

## OIDC Trusted Publishing & topological order

.github/workflows/release.yml publishes all 20 @forge-fr/* packages in strict topological order (core → router → http → ... → cli) with npm OIDC provenance enabled and dry_run: true by default.

| Release Property | Verified Value |
| --- | --- |
| Current Workspace Version | 1.0.0-rc.1 (synchronized across all 20 packages) |
| License | MIT |
| Tarball Verification | 20/20 packages verified via npm pack + isolated Node 22 & Bun 1.4 consumer installs |
| Registry Publication Status | Ready for maintainer dispatch under @next tag (no live npm publish executed automatically) |
