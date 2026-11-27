# ForgeJS — Reproducible Performance Benchmarks (Milestone 7.1)

Published with zero cherry-picking under `TESTING_STRATEGY.md` Section 5: identical 24-route tables, warmup windows, keep-alive concurrency (`24`), isolated subprocess cold-start/memory probes (`5` iterations each), and exact runtime/hardware versions.

How to reproduce identically:
```bash
node benchmarks/run-all.mjs
bun benchmarks/run-all.mjs
```

## Runtime: Node.js v22.23.5

- **OS / CPU / RAM:** Linux 4.19.0-gvisor (x64) · 2 vCPU (unknown) · 4096 MB
- **Versions:** ForgeJS `0.1.0` *(identical runtime code bumped to `v1.0.0-rc.1` in Milestone 7.3)* · Hono `^4.13.22` (`@hono/node-server ^2.1.11`) · Fastify `^5.12.8` · Zod `^4.6.7` · Tinybench `^6.2.5`

### 1. Live Loopback HTTP Throughput & Latency (`concurrency = 24`, `warmup = 600ms`, `duration = 1200ms`)

| Scenario | Framework | req/s | Total Req | Failed | p50 (ms) | p95 (ms) | p99 (ms) |
| :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| GET /json (Static JSON) | **forgejs** | 3,867.36 | 4,650 | 0 | 5.65 | 10.19 | 13.74 |
| GET /json (Static JSON) | **hono** | 3,724.83 | 4,483 | 0 | 5.78 | 10.72 | 12.62 |
| GET /json (Static JSON) | **fastify** | 3,864.97 | 4,647 | 0 | 5.61 | 10.78 | 18.68 |
| GET /users/:id/posts?limit=15 (Param + Query) | **forgejs** | 3,877.08 | 4,662 | 0 | 5.75 | 10.27 | 11.39 |
| GET /users/:id/posts?limit=15 (Param + Query) | **hono** | 3,681.48 | 4,445 | 0 | 5.95 | 10.68 | 14.77 |
| GET /users/:id/posts?limit=15 (Param + Query) | **fastify** | 3,826.9 | 4,604 | 0 | 5.69 | 10.15 | 14.83 |
| GET /mw/ping (5-Middleware Chain) | **forgejs** | 3,977.83 | 4,783 | 0 | 5.62 | 10.46 | 11.62 |
| GET /mw/ping (5-Middleware Chain) | **hono** | 3,755.81 | 4,515 | 0 | 5.83 | 10 | 13.9 |
| GET /mw/ping (5-Middleware Chain) | **fastify** | 3,898.31 | 4,684 | 0 | 5.66 | 10.19 | 12.8 |
| POST /items (Zod JSON Validation) | **forgejs** | 3,336.7 | 4,013 | 0 | 6.66 | 10.27 | 13.46 |
| POST /items (Zod JSON Validation) | **hono** | 3,062.38 | 3,682 | 0 | 7.19 | 12.65 | 17.49 |
| POST /items (Zod JSON Validation) | **fastify** | 3,435.71 | 4,130 | 0 | 6.49 | 10.58 | 13.71 |

### 2. Cold Startup (`5` Isolated Subprocesses) & Memory Footprint

| Framework | Cold Start Median (ms) | Cold Start Range (ms) | Idle RSS (MB) | Idle Heap (MB) | Loaded RSS (MB) | Loaded Heap (MB) |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| **forgejs** | 61.01 | 52.69–66.19 | 159.68 | 13.33 | 162.95 | 19.33 |
| **hono** | 61.44 | 51.67–62.25 | 159.5 | 13.41 | 162.9 | 15.54 |
| **fastify** | 163.92 | 154.82–169.53 | 154.89 | 15.34 | 157.69 | 22.9 |

### 3. In-Process Microbenchmarks (`tinybench`)

| Benchmark | ops/sec | Mean (ms) | p75 (ms) | p99 (ms) | Samples |
| :--- | ---: | ---: | ---: | ---: | ---: |
| ForgeJS Radix Router (static + dynamic + 404 match) | 586,190 | 0.0018 | 0.0017 | 0.0023 | 277692 |
| ForgeJS In-Process Static JSON (app.fetch) | 317,446 | 0.0034 | 0.0032 | 0.0051 | 147632 |
| Hono In-Process Static JSON (app.fetch) | 131,194 | 0.0081 | 0.0077 | 0.0151 | 62085 |
| Fastify In-Process Static JSON (app.inject) | 15,197 | 0.1001 | 0.0837 | 0.2246 | 4996 |
| ForgeJS 5-Middleware Chain (/mw/ping) | 254,577 | 0.0043 | 0.004 | 0.0066 | 116240 |
| Hono 5-Middleware Chain (/mw/ping) | 97,585 | 0.0111 | 0.0104 | 0.0245 | 45213 |
| Fastify 5-Hook Chain (/mw/ping) | 22,392 | 0.0632 | 0.0534 | 0.1369 | 7908 |
| ForgeJS Zod Validated POST (/items) | 53,646 | 0.0214 | 0.0186 | 0.064 | 23345 |
| Hono Zod Validated POST (/items) | 43,419 | 0.0251 | 0.023 | 0.0656 | 19915 |
| Fastify Zod Validated POST (/items) | 11,868 | 0.116 | 0.104 | 0.2813 | 4310 |
| DI Singleton Resolve | 7,534,415 | 0.0002 | 0.0001 | 0.0003 | 3171719 |
| DI Transient Resolve | 3,749,618 | 0.0003 | 0.0003 | 0.0007 | 1573549 |
| DI Request Scope Create + Resolve + Dispose | 1,188,899 | 0.001 | 0.0009 | 0.0016 | 521449 |
| 5-Module Kernel Boot + Shutdown | 34,053 | 0.0322 | 0.0298 | 0.0911 | 15531 |

## Runtime: Bun 1.4.4

- **OS / CPU / RAM:** Linux 4.19.0-gvisor (x64) · 2 vCPU (unknown) · 4096 MB
- **Versions:** ForgeJS `0.1.0` *(identical runtime code bumped to `v1.0.0-rc.1` in Milestone 7.3)* · Hono `^4.13.22` (`@hono/node-server ^2.1.11`) · Fastify `^5.12.8` · Zod `^4.6.7` · Tinybench `^6.2.5`

### 1. Live Loopback HTTP Throughput & Latency (`concurrency = 24`, `warmup = 600ms`, `duration = 1200ms`)

| Scenario | Framework | req/s | Total Req | Failed | p50 (ms) | p95 (ms) | p99 (ms) |
| :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| GET /json (Static JSON) | **forgejs** | 7,275.57 | 8,737 | 0 | 2.97 | 6.54 | 10.93 |
| GET /json (Static JSON) | **hono** | 7,570.29 | 9,091 | 0 | 2.77 | 6.26 | 11.7 |
| GET /json (Static JSON) | **fastify** | 6,538.15 | 7,855 | 0 | 3.39 | 6.22 | 11.97 |
| GET /users/:id/posts?limit=15 (Param + Query) | **forgejs** | 7,862.83 | 9,447 | 0 | 2.79 | 4.45 | 7.38 |
| GET /users/:id/posts?limit=15 (Param + Query) | **hono** | 7,848.43 | 9,444 | 0 | 2.84 | 4.02 | 8.68 |
| GET /users/:id/posts?limit=15 (Param + Query) | **fastify** | 6,642.78 | 7,981 | 0 | 3.34 | 5.6 | 10.43 |
| GET /mw/ping (5-Middleware Chain) | **forgejs** | 8,216.07 | 9,866 | 0 | 2.67 | 4.42 | 7.55 |
| GET /mw/ping (5-Middleware Chain) | **hono** | 7,005.5 | 8,414 | 0 | 2.88 | 6.17 | 12.22 |
| GET /mw/ping (5-Middleware Chain) | **fastify** | 6,796.26 | 8,164 | 0 | 3.34 | 5.5 | 7.44 |
| POST /items (Zod JSON Validation) | **forgejs** | 6,454.94 | 7,753 | 0 | 3.39 | 5.43 | 12.48 |
| POST /items (Zod JSON Validation) | **hono** | 6,760.82 | 8,122 | 0 | 3.3 | 5.33 | 9.75 |
| POST /items (Zod JSON Validation) | **fastify** | 4,498.12 | 5,408 | 0 | 4.81 | 7.5 | 14.42 |

### 2. Cold Startup (`5` Isolated Subprocesses) & Memory Footprint

| Framework | Cold Start Median (ms) | Cold Start Range (ms) | Idle RSS (MB) | Idle Heap (MB) | Loaded RSS (MB) | Loaded Heap (MB) |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| **forgejs** | 11.08 | 10.9–14.17 | 185.72 | 5.49 | 193.6 | 9.74 |
| **hono** | 10.79 | 10.46–11.48 | 187.48 | 4.56 | 201.56 | 10.47 |
| **fastify** | 112.25 | 107.95–123.81 | 193.45 | 6.92 | 217.44 | 10.18 |

### 3. In-Process Microbenchmarks (`tinybench`)

| Benchmark | ops/sec | Mean (ms) | p75 (ms) | p99 (ms) | Samples |
| :--- | ---: | ---: | ---: | ---: | ---: |
| ForgeJS Radix Router (static + dynamic + 404 match) | 651,594 | 0.0018 | 0.0015 | 0.0078 | 274008 |
| ForgeJS In-Process Static JSON (app.fetch) | 721,724 | 0.0018 | 0.0014 | 0.0166 | 271910 |
| Hono In-Process Static JSON (app.fetch) | 525,907 | 0.0024 | 0.002 | 0.0162 | 209312 |
| Fastify In-Process Static JSON (app.inject) | 44,613 | 0.0393 | 0.0295 | 0.1195 | 12729 |
| ForgeJS 5-Middleware Chain (/mw/ping) | 446,581 | 0.0033 | 0.0025 | 0.0245 | 153233 |
| Hono 5-Middleware Chain (/mw/ping) | 205,246 | 0.0058 | 0.0054 | 0.0311 | 86795 |
| Fastify 5-Hook Chain (/mw/ping) | 47,400 | 0.027 | 0.0255 | 0.0825 | 18549 |
| ForgeJS Zod Validated POST (/items) | 244,320 | 0.0058 | 0.0044 | 0.0306 | 86741 |
| Hono Zod Validated POST (/items) | 214,530 | 0.0055 | 0.005 | 0.0341 | 90446 |
| Fastify Zod Validated POST (/items) | 30,506 | 0.0435 | 0.0355 | 0.1883 | 11484 |
| DI Singleton Resolve | 6,250,984 | 0.0002 | 0.0002 | 0.0015 | 2272500 |
| DI Transient Resolve | 3,799,900 | 0.0004 | 0.0003 | 0.0022 | 1387237 |
| DI Request Scope Create + Resolve + Dispose | 1,351,234 | 0.001 | 0.0009 | 0.0036 | 503583 |
| 5-Module Kernel Boot + Shutdown | 37,340 | 0.0292 | 0.0286 | 0.0837 | 17136 |
