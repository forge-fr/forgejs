import { ConfigurationError } from '@forge-fr/core';
import { matchesPermission, type RbacRegistry } from './permissions.js';
import { checkTenantIsolation, type TenantGuardOptions } from './tenant.js';
import {
  createDecision,
  isValidActor,
  type Actor,
  type AuthorizationAuditHook,
  type AuthorizationDecision,
  type AuthorizationEffect,
} from './types.js';

export interface PolicyEvaluationInput<TResource = unknown, TContext = unknown> {
  readonly actor: Actor;
  readonly action: string;
  readonly resource: TResource;
  readonly context: TContext;
}

export interface PolicyRule<TResource = unknown, TContext = unknown> {
  readonly name: string;
  readonly effect: AuthorizationEffect;
  readonly actions: readonly string[];
  readonly resourceType?: string;
  readonly condition: (
    input: PolicyEvaluationInput<TResource, TContext>,
  ) => boolean | Promise<boolean>;
}

export interface PolicyEngineOptions {
  readonly policies?: readonly PolicyRule<any, any>[];
  readonly rbac?: RbacRegistry;
  /**
   * When true, any resource carrying a `tenantId` property (or custom extractor)
   * MUST pass tenant isolation before any RBAC or allow policy can succeed.
   */
  readonly enforceTenantIsolation?: boolean;
  readonly tenantOptions?: TenantGuardOptions<unknown>;
  readonly onDecision?: AuthorizationAuditHook;
}

export interface PolicyEngine {
  evaluate<TResource = unknown, TContext = unknown>(
    actor: Actor | null | undefined,
    action: string,
    resource?: TResource,
    context?: TContext,
  ): Promise<AuthorizationDecision>;
}

export function definePolicy<TResource = unknown, TContext = unknown>(
  rule: PolicyRule<TResource, TContext>,
): PolicyRule<TResource, TContext> {
  if (typeof rule.name !== 'string' || rule.name.trim().length === 0) {
    throw new ConfigurationError('Policy rule requires a non-empty name');
  }
  if (rule.effect !== 'allow' && rule.effect !== 'deny') {
    throw new ConfigurationError(`Policy "${rule.name}" effect must be "allow" or "deny"`);
  }
  if (!Array.isArray(rule.actions) || rule.actions.length === 0) {
    throw new ConfigurationError(`Policy "${rule.name}" must specify at least one action`);
  }
  if (typeof rule.condition !== 'function') {
    throw new ConfigurationError(`Policy "${rule.name}" requires a condition function`);
  }
  return Object.freeze({
    ...rule,
    actions: Object.freeze([...rule.actions]),
  });
}

function extractResourceType(resource: unknown, context: unknown): string | undefined {
  if (resource !== null && typeof resource === 'object') {
    const rec = resource as Record<string, unknown>;
    if (typeof rec['type'] === 'string' && rec['type'].length > 0) {
      return rec['type'];
    }
    if (typeof rec['resourceType'] === 'string' && rec['resourceType'].length > 0) {
      return rec['resourceType'];
    }
  }
  if (context !== null && typeof context === 'object') {
    const ctxRec = context as Record<string, unknown>;
    if (typeof ctxRec['resourceType'] === 'string' && ctxRec['resourceType'].length > 0) {
      return ctxRec['resourceType'];
    }
  }
  return undefined;
}

function ruleMatches(
  rule: PolicyRule<any, any>,
  action: string,
  resourceType: string | undefined,
): boolean {
  if (rule.resourceType !== undefined && rule.resourceType !== resourceType) {
    return false;
  }
  return rule.actions.some((pattern) => matchesPermission(pattern, action));
}

function resourceCarriesTenant(
  resource: unknown,
  options?: TenantGuardOptions<unknown>,
): boolean {
  if (resource === null || resource === undefined) {
    return false;
  }
  if (options?.getResourceTenantId !== undefined) {
    return options.getResourceTenantId(resource) !== undefined;
  }
  return (
    typeof resource === 'object' &&
    'tenantId' in (resource as Record<string, unknown>) &&
    (resource as { readonly tenantId?: unknown }).tenantId !== undefined
  );
}

export function createPolicyEngine(options: PolicyEngineOptions = {}): PolicyEngine {
  const seenNames = new Set<string>();
  const denyRules: PolicyRule<any, any>[] = [];
  const allowRules: PolicyRule<any, any>[] = [];

  for (const rule of options.policies ?? []) {
    const validated = definePolicy(rule);
    if (seenNames.has(validated.name)) {
      throw new ConfigurationError(`Duplicate policy rule name "${validated.name}"`);
    }
    seenNames.add(validated.name);
    if (validated.effect === 'deny') {
      denyRules.push(validated);
    } else {
      allowRules.push(validated);
    }
  }

  const enforceTenantIsolation = options.enforceTenantIsolation ?? false;

  async function emitAudit(
    actor: Actor | null | undefined,
    action: string,
    decision: AuthorizationDecision,
  ): Promise<void> {
    if (options.onDecision === undefined) {
      return;
    }
    try {
      await options.onDecision(
        Object.freeze({
          subject: isValidActor(actor) ? actor.subject : null,
          tenantId: isValidActor(actor) && typeof actor.tenantId === 'string' ? actor.tenantId : null,
          action,
          allowed: decision.allowed,
          effect: decision.effect,
          reason: decision.reason,
          ...(decision.matchedRule !== undefined ? { matchedRule: decision.matchedRule } : {}),
        }),
      );
    } catch {
      // Audit hooks must never bypass or convert an authorization decision
    }
  }

  return Object.freeze({
    async evaluate<TResource = unknown, TContext = unknown>(
      actor: Actor | null | undefined,
      action: string,
      resource?: TResource,
      context?: TContext,
    ): Promise<AuthorizationDecision> {
      if (!isValidActor(actor)) {
        const decision = createDecision(false, 'Unauthenticated actor');
        await emitAudit(actor, action, decision);
        return decision;
      }

      if (typeof action !== 'string' || action.trim().length === 0) {
        const decision = createDecision(false, 'Invalid authorization action');
        await emitAudit(actor, action, decision);
        return decision;
      }

      // 1. Global tenant isolation gate (cannot be bypassed by RBAC or allow policies)
      if (enforceTenantIsolation && resourceCarriesTenant(resource, options.tenantOptions)) {
        const tenantDecision = checkTenantIsolation(actor, resource, options.tenantOptions);
        if (!tenantDecision.allowed) {
          await emitAudit(actor, action, tenantDecision);
          return tenantDecision;
        }
      }

      const resourceType = extractResourceType(resource, context);
      const input: PolicyEvaluationInput<TResource, TContext> = Object.freeze({
        actor,
        action,
        resource: resource as TResource,
        context: context as TContext,
      });

      // 2. Explicit DENY rules run first — deny ALWAYS overrides allow (both Policy deny and RBAC explicit deny)
      if (options.rbac !== undefined) {
        const effective = options.rbac.resolve(actor);
        for (const deniedRule of effective.denied) {
          if (matchesPermission(deniedRule, action)) {
            const decision = createDecision(false, 'Denied by explicit RBAC rule', `rbac:deny:${deniedRule}`);
            await emitAudit(actor, action, decision);
            return decision;
          }
        }
      }

      for (const rule of denyRules) {
        if (!ruleMatches(rule, action, resourceType)) {
          continue;
        }
        try {
          const matched = await rule.condition(input);
          if (matched === true) {
            const decision = createDecision(false, 'Denied by explicit policy', rule.name);
            await emitAudit(actor, action, decision);
            return decision;
          }
        } catch {
          // Fail-closed on predicate failure
          const decision = createDecision(false, 'Policy evaluation failed');
          await emitAudit(actor, action, decision);
          return decision;
        }
      }

      // 3. Explicit ALLOW policies
      for (const rule of allowRules) {
        if (!ruleMatches(rule, action, resourceType)) {
          continue;
        }
        try {
          const matched = await rule.condition(input);
          if (matched === true) {
            const decision = createDecision(true, 'Allowed by policy', rule.name);
            await emitAudit(actor, action, decision);
            return decision;
          }
        } catch {
          // Fail-closed on predicate failure without leaking internal error details
          const decision = createDecision(false, 'Policy evaluation failed');
          await emitAudit(actor, action, decision);
          return decision;
        }
      }

      // 4. RBAC fallback (respects RBAC deny-overrides-allow)
      if (options.rbac !== undefined && options.rbac.hasPermission(actor, action)) {
        const decision = createDecision(true, 'Allowed by RBAC permission', 'rbac:permission');
        await emitAudit(actor, action, decision);
        return decision;
      }

      // 5. Default deny (fail-closed)
      const defaultDeny = createDecision(false, 'Default deny: no matching allow rule');
      await emitAudit(actor, action, defaultDeny);
      return defaultDeny;
    },
  });
}
