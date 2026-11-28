# Configuration & Secrets

> Manage typed app settings with createConfigManager() and keep passwords or API keys hidden from logs using secret().

- **Section**: Core Concepts
- **Packages**: @forge-fr/core
- **Version**: v1.0.0
- **Updated**: 2026-11-27
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/concepts/configuration
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/concepts/configuration.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/architecture.md

## Typed configuration manager

createConfigManager() combines defaults, environment values, and optional schema validation while blocking unsafe key paths like __proto__, constructor, and prototype.

**File: `src/config.ts`**

```ts
import { createConfigManager, secret, type SecretValue } from '@forge-fr/core';

interface AppConfig {
  readonly port: number;
  readonly databaseUrl: SecretValue<string>;
}

const config = createConfigManager<AppConfig>({
  defaults: {
    port: 3000,
    databaseUrl: secret('postgres://localhost:5432/dev'),
  },
  values: {
    port: Number(process.env.PORT ?? 3000),
    databaseUrl: secret(process.env.DATABASE_URL ?? 'postgres://localhost:5432/dev'),
  },
});

const port = config.get<number>('port');
const dbSecret = config.get<SecretValue<string>>('databaseUrl');
// dbSecret.toString() === '[REDACTED]'
// Call dbSecret.reveal() only right where the database client needs it
```

## How SecretValue protects credentials

- Anything wrapped in secret() prints as "[REDACTED]" in JSON.stringify(), toString(), valueOf(), and console inspection.
- You explicitly call .reveal() only when handing a credential to a database, JWT signer, or S3 client.
- redactObject() scans nested objects and masks sensitive fields before logging or reporting.
