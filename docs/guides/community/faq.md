# Frequently Asked Questions

> Direct answers on runtime compatibility, ORM choices, decorators vs. typed tokens, security boundaries, and benchmark reproduction.

- **Section**: Community & Contributing
- **Packages**: @forge-fr/core, @forge-fr/http
- **Version**: v1.0.0-rc.1
- **Updated**: 2026-11-26
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/community/faq
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/community/faq.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/FRAMEWORK_FEATURE_INVENTORY.md

## Why does ForgeJS use typed tokens instead of decorators?

Explicit createToken<T>() and defineModule() avoid experimental decorator metadata overhead, preserve strict TypeScript inference without reflection polyfills, and keep cold starts fast across Node.js, Bun, and Edge.

## Which ORMs and databases are officially supported?

ForgeJS provides official packages for native PostgreSQL (@forge-fr/database via postgres-js), Drizzle ORM (@forge-fr/drizzle), and Prisma ORM (@forge-fr/prisma). TypeORM, MikroORM, Sequelize, and Knex are not shipped officially, though teams can integrate them via DatabaseAdapter.

## Is v1.0.0-rc.1 published on npm yet?

All 20 packages are verified locally via npm pack tarballs and isolated Node 22 & Bun 1.4 consumer tests, with .github/workflows/release.yml configured for OIDC Trusted Publishing. Live registry publication awaits maintainer dispatch.

## Does ForgeJS guarantee my application is secure out of the box?

No framework can guarantee application security alone. ForgeJS enforces hardened HTTP defaults (bounded bodies, prototype sanitization, redacted errors) and ships OWASP ASVS 5.0.0 primitives, while your team remains responsible for calling ownership/tenant checks, TLS termination, secret management, and WAF/DDoS infrastructure.
