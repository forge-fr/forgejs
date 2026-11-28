# Performance & Benchmarks

> How ForgeJS stays fast and the exact reproducible Node.js v22.23.5 and Bun 1.4.4 benchmark numbers from benchmarks/RESULTS.md.

- **Section**: Testing & Production
- **Packages**: @forge-fr/router, @forge-fr/http, @forge-fr/node, @forge-fr/bun
- **Version**: v1.0.0
- **Updated**: 2026-11-27
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/deployment/performance
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/deployment/performance.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/benchmarks/RESULTS.md

## Why ForgeJS handles requests quickly

- Exact static routes match in constant O(1) time before path normalization, and dynamic routes reuse memory buffers.
- Request context stays compact (creating URLs, query objects, and request IDs only when your handler actually reads them).
- Each runtime adapter uses fast native paths on Node.js and Bun while staying compatible with standard Web APIs.
- Zod v4 synchronous schemas compile to a direct safeParse() fast path at route setup.

## Measured results (Node.js v22.23.5 & Bun 1.4.4)

Measured on Linux 4.19.0-gvisor (x64, 2 vCPU, 4096 MB RAM) comparing ForgeJS against Hono ^4.13.22 and Fastify ^5.12.8 across the same 24-route setup (concurrency = 24, warmup = 600ms, duration = 1200ms).

| Benchmark Scenario | ForgeJS | Hono | Fastify |
| --- | --- | --- | --- |
| Node 22 — In-Process Static JSON (ops/s) | 317,446 | 131,194 | 15,197 |
| Node 22 — In-Process 5-Middleware (ops/s) | 254,577 | 97,585 | 22,392 |
| Node 22 — Live HTTP Static JSON (req/s) | 3,867.36 | 3,724.83 | 3,864.97 |
| Node 22 — Live HTTP 5-Middleware (req/s) | 3,977.83 | 3,755.81 | 3,898.31 |
| Node 22 — Live HTTP Zod POST (req/s) | 3,336.7 | 3,062.38 | 3,435.71 |
| Bun 1.4 — In-Process Static JSON (ops/s) | 721,724 | 525,907 | 44,613 |
| Bun 1.4 — Live HTTP 5-Middleware (req/s) | 8,216.07 | 7,005.5 | 6,796.26 |
| Bun 1.4 — Live HTTP Static JSON (req/s) | 7,275.57 | 7,570.29 | 6,538.15 |
| Cold Start Median — Node 22 / Bun 1.4 (ms) | 61.01 / 11.08 | 61.44 / 10.79 | 163.92 / 112.25 |

## Run the exact same benchmarks locally

**File: `terminal`**

```bash
node benchmarks/run-all.mjs
bun benchmarks/run-all.mjs
```
