# @forge-fr/router

> Zero-dependency URL router with instant static path lookup, typed parameter patterns, wildcards, route groups, and automatic HEAD/405 responses.

- **Version**: v1.0.0
- **Layer**: Framework Core
- **Category**: core
- **Tarball**: 16.4 kB (24 files)
- **Internal deps**: none
- **Runtime deps**: zero runtime dependencies
- **Peer deps**: none
- **HTML URL**: https://github.com/forge-fr/forgejs/api/router
- **Markdown URL**: https://github.com/forge-fr/forgejs/api/router.md

## Installation

```bash
# Add once to .npmrc: @forge-fr:registry=https://npm.pkg.github.com
npm install @forge-fr/router
```

## Runtime & Error Semantics

- **Runtime**: Zero runtime dependencies. Pure ESM radix tree with O(1) static route lookup and reused scratch arrays.
- **Errors**: Throws RouterError on duplicate static routes, invalid parameter names (including prototype keys), or malformed constraints.

## Usage Example

```ts
import { createRouter } from '@forge-fr/router';

const router = createRouter();
router.get('/users/:id{\\d+}', { name: 'getUser' });

const matched = router.match('GET', '/users/42');
// matched.status === 'found', matched.params.id === '42'
```

## Public Exports

### Router Engine

- **Values**: `createRouter`, `HTTP_METHODS`, `RouterError`
- **Types**: `GroupOptions`, `HttpMethod`, `ParamConstraint`, `RegisteredRoute`, `RouteBuilder`, `RouteMatchResult`, `RouteOptions`, `Router`, `RouterErrorCode`, `RouterOptions`
