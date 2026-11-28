# Frequently Asked Questions

> Straight answers on runtime support, database ORMs, typed tokens vs. decorators, security boundaries, and benchmarks.

- **Section**: Community & Contributing
- **Packages**: @forge-fr/core, @forge-fr/http
- **Version**: v1.0.0
- **Updated**: 2026-11-27
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/community/faq
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/community/faq.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/FRAMEWORK_FEATURE_INVENTORY.md

## Why does ForgeJS use typed tokens instead of decorators?

Plain createToken<T>() and defineModule() keep TypeScript types accurate without experimental decorator metadata or extra runtime reflection, which also keeps cold startups fast across Node.js, Bun, and Edge.

## Which databases and ORMs are officially supported?

ForgeJS ships official plugins and UnitOfWork adapters for PostgreSQL (@forge-fr/database via postgres-js), Drizzle ORM (@forge-fr/drizzle), and Prisma ORM (@forge-fr/prisma). You can still connect other ORMs or SQL databases via DatabaseAdapter.

## Where can I install v1.0.0 packages?

All 21 packages are published at v1.0.0 under the @forge-fr/* scope on public npm (https://registry.npmjs.org) and mirrored on GitHub Packages (https://npm.pkg.github.com) from https://github.com/forge-fr/forgejs.

## Does ForgeJS make my app automatically secure?

No framework can guarantee full app security on its own. ForgeJS ships safe HTTP defaults and OWASP ASVS 5.0.0 building blocks, while your team still handles ownership and tenant checks in services, HTTPS/TLS, secret management, and WAF/DDoS protection.
