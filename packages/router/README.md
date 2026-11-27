# @forge-fr/router

Standalone, zero-dependency, runtime-agnostic radix-tree HTTP router for **ForgeJS** (Node.js `>=22.18.0` and Bun `>=1.4.0`).

## Features

- Full HTTP method support: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, `HEAD`, plus `all()` and automatic `HEAD → GET` fallback.
- Deterministic precedence: static segments > constrained parameters (`:id{\d+}` or validator functions) > dynamic parameters (`:param`) > wildcard catch-all (`*path`).
- Nested `group(prefix, fn, { middleware, meta })` composition with deterministic middleware ordering and metadata merging.
- Accurate `404 Not Found` and `405 Method Not Allowed` responses including RFC-compliant sorted `Allow` headers.
- Security hardened: null-prototype `params` objects, forbidden prototype-pollution parameter names (`__proto__`, `constructor`, `prototype`), safe percent-decoding without uncaught `URIError`, and non-backtracking static lookups.
- Route introspection (`router.routes()`) for OpenAPI generation and diagnostics.
