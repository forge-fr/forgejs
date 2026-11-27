import { createToken, type ApplicationKernel, type ForgeLogger } from '@forge-fr/core';
import type { ForgeHttpApp } from '@forge-fr/http';
import type { MemoryLogSink } from '@forge-fr/logger';
import type { AuthService } from '../auth/auth.service.ts';
import type { PlaygroundStore } from '../store.ts';
import {
  ALLOWED_SANDBOX_SINKS,
  DEMO_PERSONAS,
  SAMPLE_CROSS_TENANT_TASK_ID,
  type PlaygroundRealtimeEvent,
  type SandboxResetHandler,
} from '../types.ts';
import type { ObservabilityService, ObservabilitySummary } from './observability.ts';

export interface RedactTestInput {
  readonly email: string;
  readonly password: string;
  readonly authorization: string;
  readonly apiKey: string;
  readonly clientSecret: string;
  readonly note: string;
}

export interface SystemService {
  getMeta(): {
    readonly service: string;
    readonly version: string;
    readonly runtime: string;
    readonly packages: readonly string[];
    readonly sampleCrossTenantTaskId: string;
    readonly personas: typeof DEMO_PERSONAS;
    readonly sandboxSinks: readonly string[];
  };
  verifyEventsToken(rawToken: string): Promise<{ readonly tenantId: string; readonly actorName: string }>;
  getRecentEventsCount(tenantId: string): number;
  subscribeEvents(tenantId: string, listener: (event: PlaygroundRealtimeEvent) => void): () => void;
  getLogs(): readonly unknown[];
  runPiiRedactionDemo(logger: ForgeLogger, input: RedactTestInput): Record<string, unknown> | null;
  getObservabilitySummary(kernel: ApplicationKernel, app: ForgeHttpApp): ObservabilitySummary;
  toggleHealthFault(unhealthy?: boolean): boolean;
  resetSandbox(): Promise<void>;
}

export const SystemServiceToken = createToken<SystemService>('playground:SystemService');

export interface SystemServiceDeps {
  readonly store: PlaygroundStore;
  readonly auth: AuthService;
  readonly logSink: MemoryLogSink;
  readonly observability: ObservabilityService;
  readonly onReset: SandboxResetHandler;
}

export function createSystemService(deps: SystemServiceDeps): SystemService {
  const { store, auth, logSink, observability, onReset } = deps;

  return {
    getMeta() {
      return {
        service: 'ForgeJS Live Playground — Multi-Tenant Task & Webhook API',
        version: '1.0.0-rc.1',
        runtime: `Node.js ${process.version}`,
        packages: [
          '@forge-fr/core',
          '@forge-fr/node',
          '@forge-fr/http',
          '@forge-fr/validation',
          '@forge-fr/auth',
          '@forge-fr/authorization',
          '@forge-fr/security',
          '@forge-fr/cache',
          '@forge-fr/queue',
          '@forge-fr/storage',
          '@forge-fr/logger',
          '@forge-fr/openapi',
        ],
        sampleCrossTenantTaskId: SAMPLE_CROSS_TENANT_TASK_ID,
        personas: DEMO_PERSONAS,
        sandboxSinks: Array.from(ALLOWED_SANDBOX_SINKS),
      };
    },

    verifyEventsToken(rawToken: string) {
      return auth.verifySseToken(rawToken);
    },

    getRecentEventsCount(tenantId: string): number {
      return store.getRecentEventsForTenant(tenantId, 10).length;
    },

    subscribeEvents(tenantId: string, listener: (event: PlaygroundRealtimeEvent) => void): () => void {
      return store.subscribe(tenantId, listener);
    },

    getLogs(): readonly unknown[] {
      return logSink.entries().slice(-35).reverse();
    },

    runPiiRedactionDemo(logger: ForgeLogger, input: RedactTestInput): Record<string, unknown> | null {
      const marker = `redact_probe_${Date.now().toString(36)}`;
      logger.info(`Security audit probe ${marker}`, {
        probeMarker: marker,
        email: input.email,
        password: input.password,
        authorization: input.authorization,
        apiKey: input.apiKey,
        nested: {
          clientSecret: input.clientSecret,
          token: input.apiKey,
        },
        note: input.note,
      });

      const entries = logSink.entries();
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const entry = entries[i];
        if (entry && entry['probeMarker'] === marker) {
          return entry;
        }
      }
      return entries[entries.length - 1] ?? null;
    },

    getObservabilitySummary(kernel: ApplicationKernel, app: ForgeHttpApp): ObservabilitySummary {
      return observability.getSummary(kernel, app);
    },

    toggleHealthFault(unhealthy?: boolean): boolean {
      const next = unhealthy !== undefined ? unhealthy : !observability.isFaultInjected();
      return observability.setFaultInjected(next);
    },

    async resetSandbox(): Promise<void> {
      await onReset();
    },
  };
}
