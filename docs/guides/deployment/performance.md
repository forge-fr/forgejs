# Performance & Benchmarks

> Hot-path HTTP optimizations and verbatim reproducible Node.js v22.23.5 & Bun 1.4.4 benchmark results from benchmarks/RESULTS.md.

- **Section**: Testing & Production
- **Packages**: @forge-fr/router, @forge-fr/http, @forge-fr/node, @forge-fr/bun
- **Version**: v1.0.0-rc.1
- **Updated**: 2026-11-26
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/deployment/performance
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/deployment/performance.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/benchmarks/RESULTS.md

## Hot-path engineering

- Pre-normalization O(1) staticByMethod lookup and reused scratch-array radix matching in @forge-fr/router.
- Compact 13-field ForgeContext with lazy on-demand requestId and inline route._pipelineRun caching in @forge-fr/http.
- Direct-meta FastNodeRequest & FastResponse on Node.js; pure-HTTP Bun.serve mode with pre-allocated Headers presets on Bun.
- compileFastValidator() direct Zod v4 safeParse fast path with automatic Standard Schema fallback.

## Measured results (Node.js v22.23.5 & Bun 1.4.4)

Measured on Linux 4.19.0-gvisor (x64, 2 vCPU, 4096 MB RAM) comparing ForgeJS against Hono ^4.13.22 and Fastify ^5.12.8 across identical 24-route tables (concurrency = 24, warmup = 600ms, duration = 1200ms).

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

## Reproduce identically

**File: `terminal`**

```bash
node benchmarks/run-all.mjs
bun benchmarks/run-all.mjs
```
