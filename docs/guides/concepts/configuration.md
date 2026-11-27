# Configuration & Secrets

> Typed configuration management via createConfigManager(), prototype-safe key guards, and credential masking with secret() and SecretValue.

- **Section**: Core Concepts
- **Packages**: @forge-fr/core
- **Version**: v1.0.0-rc.1
- **Updated**: 2026-11-26
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/concepts/configuration
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/concepts/configuration.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/architecture.md

## Typed configuration manager

createConfigManager() layers defaults, explicit runtime values, and optional Standard Schema validation while rejecting __proto__, constructor, and prototype key paths.

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
// dbSecret.reveal() returns the raw string only at the driver boundary
```

## SecretValue redaction guarantees

- Values wrapped with secret() serialize to REDACTED_PLACEHOLDER ("[REDACTED]") in JSON.stringify(), toString(), valueOf(), and Node/Bun inspect output.
- Call .reveal() explicitly only when passing credentials to a database, JWT, or S3 client.
- redactObject() recursively masks secret keys across nested configuration or telemetry objects.
