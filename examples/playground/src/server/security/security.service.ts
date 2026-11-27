import { createToken, ValidationError } from '@forge-fr/core';
import type { AuthIdentity } from '@forge-fr/auth';
import {
  createMemoryRateLimitStore,
  generateCsrfToken,
  isDangerousPropertyKey,
  resolveConfinedPath,
  safeJsonParse,
  type RateLimitStore,
} from '@forge-fr/security';

export const DEMO_RATE_LIMIT_MAX = 3;
export const DEMO_RATE_LIMIT_WINDOW_MS = 15_000;
export const SANDBOX_CONFINED_ROOT = '/sandbox/uploads';

export interface SanitizeProbeResult {
  readonly blockedKeysDetected: readonly string[];
  readonly sanitizedPayload: unknown;
  readonly prototypePolluted: boolean;
}

export interface PathProbeResult {
  readonly allowed: true;
  readonly root: string;
  readonly requestedPath: string;
  readonly resolvedPath: string;
}

export interface SecurityService {
  readonly demoRateLimitStore: RateLimitStore;
  issueCsrfToken(identity: AuthIdentity): string;
  getExpectedCsrfToken(identity: AuthIdentity): string | null;
  probePrototypePollution(rawJson: string): SanitizeProbeResult;
  probePathConfinement(untrustedPath: string): PathProbeResult;
  resetDemoRateLimit(): void;
  resetSecurityState(): void;
}

export const SecurityServiceToken = createToken<SecurityService>('playground:SecurityService');

function csrfKey(identity: AuthIdentity): string {
  return `${identity.tenantId ?? 'anon'}:${identity.subject}`;
}

function collectDangerousKeysFromRawJson(rawJson: string): readonly string[] {
  const found = new Set<string>();
  const keyMatches = rawJson.matchAll(/"([^"\\]+)"\s*:/g);
  for (const match of keyMatches) {
    const key = match[1];
    if (key && isDangerousPropertyKey(key)) {
      found.add(key);
    }
  }
  return Array.from(found);
}

export function createSecurityService(): SecurityService {
  let activeRateLimitStore = createMemoryRateLimitStore({ maxKeys: 500 });
  const csrfTokens = new Map<string, string>();

  const delegatingRateLimitStore: RateLimitStore = {
    consume(key, windowMs, max) {
      return activeRateLimitStore.consume(key, windowMs, max);
    },
  };

  return {
    demoRateLimitStore: delegatingRateLimitStore,

    issueCsrfToken(identity: AuthIdentity): string {
      const token = generateCsrfToken(32);
      csrfTokens.set(csrfKey(identity), token);
      return token;
    },

    getExpectedCsrfToken(identity: AuthIdentity): string | null {
      return csrfTokens.get(csrfKey(identity)) ?? null;
    },

    probePrototypePollution(rawJson: string): SanitizeProbeResult {
      if (typeof rawJson !== 'string' || rawJson.trim().length === 0) {
        throw new ValidationError('Raw JSON string payload is required');
      }
      const blockedKeysDetected = collectDangerousKeysFromRawJson(rawJson);
      const sanitizedNullProto = safeJsonParse<unknown>(rawJson, { maxDepth: 16 });
      // Re-serialize through JSON to return a clean plain JSON snapshot for response rendering
      const serializable = JSON.parse(JSON.stringify(sanitizedNullProto)) as unknown;
      const probeTarget: Record<string, unknown> = {};
      return {
        blockedKeysDetected,
        sanitizedPayload: serializable,
        prototypePolluted: probeTarget['polluted'] === true || ({} as Record<string, unknown>)['isAdmin'] === true,
      };
    },

    probePathConfinement(untrustedPath: string): PathProbeResult {
      const resolvedPath = resolveConfinedPath(SANDBOX_CONFINED_ROOT, untrustedPath);
      return {
        allowed: true,
        root: SANDBOX_CONFINED_ROOT,
        requestedPath: untrustedPath,
        resolvedPath,
      };
    },

    resetDemoRateLimit(): void {
      activeRateLimitStore = createMemoryRateLimitStore({ maxKeys: 500 });
    },

    resetSecurityState(): void {
      activeRateLimitStore = createMemoryRateLimitStore({ maxKeys: 500 });
      csrfTokens.clear();
    },
  };
}
