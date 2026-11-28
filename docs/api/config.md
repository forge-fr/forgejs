# @forge-fr/config

> Strongly typed environment and .env configuration validated with Zod, Valibot, or Standard Schema v1, with automatic secret redaction and Edge-safe loaders.

- **Version**: v1.0.0
- **Layer**: Framework Core
- **Category**: core
- **Tarball**: 12.4 kB (28 files)
- **Internal deps**: @forge-fr/core
- **Runtime deps**: @standard-schema/spec ^1.1.0
- **Peer deps**: zod >=3.24 || >=4 (optional), valibot >=1 (optional)
- **HTML URL**: https://github.com/forge-fr/forgejs/api/config
- **Markdown URL**: https://github.com/forge-fr/forgejs/api/config.md

## Installation

```bash
# Add once to .npmrc: @forge-fr:registry=https://npm.pkg.github.com
npm install @forge-fr/config
```

## Plugin Metadata

- **Factory**: `createConfigPlugin`
- **Tokens**: `ConfigTokens`
- **Health probe**: `config:validated`
- **Capabilities**: `di:register`, `health:register`

## Runtime & Error Semantics

- **Runtime**: Root entry (@forge-fr/config) has zero node:* or Bun globals and runs identically on Node.js, Bun, and WinterCG Edge. Use @forge-fr/config/node for filesystem .env layering on Node.js and Bun.
- **Errors**: Throws ConfigValidationError with secret-safe diagnostics (sensitive values like PASSWORD, SECRET, TOKEN, or DATABASE_URL are never echoed in error messages).

## Usage Example

```ts
import { defineConfig, createConfigPlugin, createConfigToken } from '@forge-fr/config';
import { z } from 'zod';

const AppSchema = z.object({
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().url(),
});

const config = defineConfig({ schema: AppSchema, env: process.env });
const AppConfigToken = createConfigToken<typeof config>('AppConfig');
const plugin = createConfigPlugin({ schema: AppSchema, token: AppConfigToken });
```

## Public Exports

### Typed Configuration & Loaders

- **Values**: `defineConfig`, `loadConfig`, `createConfigLoader`, `readRuntimeEnv`, `parseDotEnv`
- **Types**: `ConfigLoader`, `ConfigOutput`, `DefineConfigOptions`, `EnvSource`, `LoadConfigOptions`, `ParseDotEnvOptions`

### Errors, Secret Redaction & Plugin

- **Values**: `ConfigValidationError`, `buildSecretKeySet`, `isSecretConfigKey`, `redactConfig`, `sanitizeConfigMessage`, `ConfigTokens`, `createConfigToken`, `createConfigPlugin`
- **Types**: `ConfigValidationIssue`, `RedactConfigOptions`, `ConfigPluginOptions`
