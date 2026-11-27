import { ConflictError } from './errors.js';

export type HealthStatus = 'ok' | 'degraded' | 'unhealthy';

export interface HealthCheckResult {
  readonly status: HealthStatus;
  readonly message?: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly durationMs?: number;
}

export type HealthCheckFn = () => HealthCheckResult | Promise<HealthCheckResult>;

export interface HealthReport {
  readonly status: HealthStatus;
  readonly timestamp: string;
  readonly checks: Readonly<Record<string, HealthCheckResult>>;
}

export interface HealthRegistry {
  register(name: string, check: HealthCheckFn): () => void;
  unregister(name: string): boolean;
  has(name: string): boolean;
  list(): readonly string[];
  runAll(): Promise<HealthReport>;
  clear(): void;
}

class ForgeHealthRegistry implements HealthRegistry {
  private readonly checks = new Map<string, HealthCheckFn>();

  public register(name: string, check: HealthCheckFn): () => void {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      throw new Error('Health check name must be a non-empty string');
    }
    if (this.checks.has(trimmed)) {
      throw new ConflictError(`Health check "${trimmed}" is already registered`, {
        details: { checkName: trimmed },
      });
    }
    this.checks.set(trimmed, check);
    return () => {
      if (this.checks.get(trimmed) === check) {
        this.checks.delete(trimmed);
      }
    };
  }

  public unregister(name: string): boolean {
    return this.checks.delete(name);
  }

  public has(name: string): boolean {
    return this.checks.has(name);
  }

  public list(): readonly string[] {
    return Object.freeze(Array.from(this.checks.keys()));
  }

  public async runAll(): Promise<HealthReport> {
    const results: Record<string, HealthCheckResult> = Object.create(null) as Record<
      string,
      HealthCheckResult
    >;
    let overall: HealthStatus = 'ok';

    for (const [name, fn] of Array.from(this.checks.entries())) {
      const start = Date.now();
      try {
        const res = await fn();
        const durationMs = Date.now() - start;
        results[name] = Object.freeze({
          status: res.status,
          ...(res.message !== undefined ? { message: res.message } : {}),
          ...(res.details !== undefined ? { details: Object.freeze({ ...res.details }) } : {}),
          durationMs,
        });
        if (res.status === 'unhealthy') {
          overall = 'unhealthy';
        } else if (res.status === 'degraded' && overall === 'ok') {
          overall = 'degraded';
        }
      } catch (err: unknown) {
        const durationMs = Date.now() - start;
        results[name] = Object.freeze({
          status: 'unhealthy',
          message: err instanceof Error ? err.message : 'Health check failed',
          durationMs,
        });
        overall = 'unhealthy';
      }
    }

    return Object.freeze({
      status: overall,
      timestamp: new Date().toISOString(),
      checks: Object.freeze(results),
    });
  }

  public clear(): void {
    this.checks.clear();
  }
}

export function createHealthRegistry(): HealthRegistry {
  return new ForgeHealthRegistry();
}
