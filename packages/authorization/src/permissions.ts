import { ConfigurationError } from '@forge-fr/core';
import { isForbiddenKey, isValidActor, type Actor } from './types.js';

export interface RoleDefinition {
  readonly permissions: readonly string[];
  readonly deniedPermissions?: readonly string[];
  readonly inherits?: readonly string[];
}

export type RoleDefinitionsMap = Readonly<Record<string, RoleDefinition>>;

export interface EffectivePermissions {
  readonly roles: ReadonlySet<string>;
  readonly allowed: readonly string[];
  readonly denied: readonly string[];
}

export interface RbacRegistry {
  readonly roleNames: readonly string[];
  resolve(actor: Actor | null | undefined): EffectivePermissions;
  hasRole(actor: Actor | null | undefined, role: string): boolean;
  hasAnyRole(actor: Actor | null | undefined, roles: readonly string[]): boolean;
  hasAllRoles(actor: Actor | null | undefined, roles: readonly string[]): boolean;
  hasPermission(actor: Actor | null | undefined, permission: string): boolean;
  hasAnyPermission(actor: Actor | null | undefined, permissions: readonly string[]): boolean;
  hasAllPermissions(actor: Actor | null | undefined, permissions: readonly string[]): boolean;
}

const VALID_IDENTIFIER_RE = /^[a-zA-Z0-9._:*!-]+$/;

function validateIdentifier(value: string, label: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    isForbiddenKey(value) ||
    !VALID_IDENTIFIER_RE.test(value)
  ) {
    throw new ConfigurationError(`Invalid ${label}: "${String(value)}"`);
  }
}

/**
 * Segment-strict permission matcher using ':' as delimiter.
 * Supports:
 * - exact match (`invoice:read`)
 * - single-segment wildcard (`invoice:*`, `*:read`, `org:*:read`)
 * - multi-segment tail wildcard (`invoice:**`)
 * - global wildcard (`*`)
 */
export function matchesPermission(granted: string, required: string): boolean {
  if (
    typeof granted !== 'string' ||
    typeof required !== 'string' ||
    granted.length === 0 ||
    required.length === 0 ||
    granted.startsWith('!') ||
    required.startsWith('!')
  ) {
    return false;
  }

  if (granted === '*') {
    return true;
  }
  if (granted === required) {
    return true;
  }

  const gParts = granted.split(':');
  const rParts = required.split(':');

  for (let i = 0; i < gParts.length; i += 1) {
    const gSeg = gParts[i];
    if (gSeg === '**') {
      return i === gParts.length - 1 && rParts.length >= i + 1;
    }
    if (i >= rParts.length) {
      return false;
    }
    const rSeg = rParts[i];
    if (gSeg !== '*' && gSeg !== rSeg) {
      return false;
    }
  }

  return gParts.length === rParts.length;
}

interface CompiledRole {
  readonly roles: ReadonlySet<string>;
  readonly allowed: readonly string[];
  readonly denied: readonly string[];
}

export function createRbacRegistry(definitions: RoleDefinitionsMap = {}): RbacRegistry {
  const rawEntries = new Map<string, RoleDefinition>();

  for (const roleName of Object.keys(definitions)) {
    validateIdentifier(roleName, 'role name');
    const def = definitions[roleName];
    if (def === undefined) {
      continue;
    }
    if (!Array.isArray(def.permissions)) {
      throw new ConfigurationError(`Role "${roleName}" must declare a permissions array`);
    }
    for (const perm of def.permissions) {
      validateIdentifier(perm, `permission in role "${roleName}"`);
    }
    if (def.deniedPermissions !== undefined) {
      for (const perm of def.deniedPermissions) {
        validateIdentifier(perm, `denied permission in role "${roleName}"`);
      }
    }
    if (def.inherits !== undefined) {
      for (const parent of def.inherits) {
        validateIdentifier(parent, `inherited role in "${roleName}"`);
      }
    }
    rawEntries.set(roleName, def);
  }

  // Validate all inherited roles exist
  for (const [roleName, def] of rawEntries) {
    for (const parent of def.inherits ?? []) {
      if (!rawEntries.has(parent)) {
        throw new ConfigurationError(
          `Role "${roleName}" inherits unknown role "${parent}"`,
        );
      }
    }
  }

  // Detect cycles & compile flattened role hierarchy via DFS
  const compiled = new Map<string, CompiledRole>();
  const visiting = new Set<string>();

  function compileRole(roleName: string, stack: string[]): CompiledRole {
    const existing = compiled.get(roleName);
    if (existing !== undefined) {
      return existing;
    }
    if (visiting.has(roleName)) {
      const cycleStart = stack.indexOf(roleName);
      const chain = [...stack.slice(cycleStart), roleName].join(' -> ');
      throw new ConfigurationError(`Circular role inheritance detected: ${chain}`);
    }

    visiting.add(roleName);
    const def = rawEntries.get(roleName)!;
    const roleSet = new Set<string>([roleName]);
    const allowedSet = new Set<string>();
    const deniedSet = new Set<string>();

    for (const parentName of def.inherits ?? []) {
      const parentCompiled = compileRole(parentName, [...stack, roleName]);
      for (const r of parentCompiled.roles) {
        roleSet.add(r);
      }
      for (const a of parentCompiled.allowed) {
        allowedSet.add(a);
      }
      for (const d of parentCompiled.denied) {
        deniedSet.add(d);
      }
    }

    for (const entry of def.permissions) {
      if (entry.startsWith('!')) {
        const stripped = entry.slice(1);
        if (stripped.length > 0) {
          deniedSet.add(stripped);
        }
      } else {
        allowedSet.add(entry);
      }
    }

    for (const entry of def.deniedPermissions ?? []) {
      const stripped = entry.startsWith('!') ? entry.slice(1) : entry;
      if (stripped.length > 0) {
        deniedSet.add(stripped);
      }
    }

    visiting.delete(roleName);
    const result: CompiledRole = Object.freeze({
      roles: roleSet,
      allowed: Object.freeze([...allowedSet]),
      denied: Object.freeze([...deniedSet]),
    });
    compiled.set(roleName, result);
    return result;
  }

  for (const roleName of rawEntries.keys()) {
    compileRole(roleName, []);
  }

  function resolve(actor: Actor | null | undefined): EffectivePermissions {
    if (!isValidActor(actor)) {
      return Object.freeze({
        roles: new Set<string>(),
        allowed: Object.freeze([]),
        denied: Object.freeze([]),
      });
    }

    const effectiveRoles = new Set<string>();
    const allowedSet = new Set<string>();
    const deniedSet = new Set<string>();

    for (const roleName of actor.roles) {
      if (typeof roleName !== 'string' || roleName.length === 0 || isForbiddenKey(roleName)) {
        continue;
      }
      const comp = compiled.get(roleName);
      if (comp !== undefined) {
        for (const r of comp.roles) {
          effectiveRoles.add(r);
        }
        for (const a of comp.allowed) {
          allowedSet.add(a);
        }
        for (const d of comp.denied) {
          deniedSet.add(d);
        }
      } else if (VALID_IDENTIFIER_RE.test(roleName)) {
        // Keep unknown role names safe for direct role checks without granting permissions
        effectiveRoles.add(roleName);
      }
    }

    for (const perm of actor.permissions) {
      if (typeof perm !== 'string' || perm.length === 0 || isForbiddenKey(perm)) {
        continue;
      }
      if (perm.startsWith('!')) {
        const stripped = perm.slice(1);
        if (stripped.length > 0) {
          deniedSet.add(stripped);
        }
      } else {
        allowedSet.add(perm);
      }
    }

    return Object.freeze({
      roles: effectiveRoles,
      allowed: Object.freeze([...allowedSet]),
      denied: Object.freeze([...deniedSet]),
    });
  }

  function hasRole(actor: Actor | null | undefined, role: string): boolean {
    if (!isValidActor(actor) || typeof role !== 'string' || role.length === 0 || isForbiddenKey(role)) {
      return false;
    }
    return resolve(actor).roles.has(role);
  }

  function hasAnyRole(actor: Actor | null | undefined, roles: readonly string[]): boolean {
    if (!isValidActor(actor) || roles.length === 0) {
      return false;
    }
    const effective = resolve(actor).roles;
    return roles.some((r) => typeof r === 'string' && !isForbiddenKey(r) && effective.has(r));
  }

  function hasAllRoles(actor: Actor | null | undefined, roles: readonly string[]): boolean {
    if (!isValidActor(actor) || roles.length === 0) {
      return false;
    }
    const effective = resolve(actor).roles;
    return roles.every((r) => typeof r === 'string' && !isForbiddenKey(r) && effective.has(r));
  }

  function hasPermission(actor: Actor | null | undefined, permission: string): boolean {
    if (
      !isValidActor(actor) ||
      typeof permission !== 'string' ||
      permission.length === 0 ||
      permission.startsWith('!') ||
      isForbiddenKey(permission)
    ) {
      return false;
    }
    const effective = resolve(actor);

    // Explicit deny ALWAYS overrides allow (including wildcards and direct actor permissions)
    for (const deniedRule of effective.denied) {
      if (matchesPermission(deniedRule, permission)) {
        return false;
      }
    }

    for (const allowedRule of effective.allowed) {
      if (matchesPermission(allowedRule, permission)) {
        return true;
      }
    }

    return false;
  }

  function hasAnyPermission(
    actor: Actor | null | undefined,
    permissions: readonly string[],
  ): boolean {
    if (!isValidActor(actor) || permissions.length === 0) {
      return false;
    }
    return permissions.some((p) => hasPermission(actor, p));
  }

  function hasAllPermissions(
    actor: Actor | null | undefined,
    permissions: readonly string[],
  ): boolean {
    if (!isValidActor(actor) || permissions.length === 0) {
      return false;
    }
    return permissions.every((p) => hasPermission(actor, p));
  }

  return Object.freeze({
    roleNames: Object.freeze([...rawEntries.keys()]),
    resolve,
    hasRole,
    hasAnyRole,
    hasAllRoles,
    hasPermission,
    hasAnyPermission,
    hasAllPermissions,
  });
}
