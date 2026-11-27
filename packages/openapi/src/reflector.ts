import { OpenApiError } from './errors.js';
import type { OpenApiSchemaObject } from './types.js';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_REFLECT_DEPTH = 32;

export interface SchemaReflectOptions {
  readonly maxDepth?: number;
  readonly customConverter?: (schema: unknown) => OpenApiSchemaObject | undefined;
}

export function sanitizeJsonSchema<T>(value: T, depth = 0): T {
  if (depth > MAX_REFLECT_DEPTH) {
    throw new OpenApiError('Schema nesting depth exceeds safety limit (32)', {
      statusCode: 400,
      expose: true,
    });
  }
  if (value === null || value === undefined || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJsonSchema(item, depth + 1)) as T;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(key)) {
      continue;
    }
    const rawVal = (value as Record<string, unknown>)[key];
    if (rawVal !== undefined) {
      Object.defineProperty(out, key, {
        value: sanitizeJsonSchema(rawVal, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return out as T;
}

function unwrapZodOptional(schema: Record<string, unknown>): {
  readonly inner: unknown;
  readonly optional: boolean;
} {
  let current: unknown = schema;
  let optional = false;

  for (let i = 0; i < 8; i += 1) {
    const def = (current as { _zod?: { def?: Record<string, unknown> } })?._zod?.def;
    if (!def) break;
    const t = def['type'];
    if (t === 'optional' || t === 'default' || t === 'prefault') {
      optional = true;
      current = def['innerType'];
    } else {
      break;
    }
  }
  return { inner: current, optional };
}

function unwrapValibotOptional(schema: Record<string, unknown>): {
  readonly inner: unknown;
  readonly optional: boolean;
} {
  let current: unknown = schema;
  let optional = false;

  for (let i = 0; i < 8; i += 1) {
    const s = current as { kind?: unknown; type?: unknown; wrapped?: unknown };
    if (s?.kind !== 'schema') break;
    if (s.type === 'optional' || s.type === 'nullish') {
      optional = true;
      current = s.wrapped;
    } else {
      break;
    }
  }
  return { inner: current, optional };
}

function isZodSchema(value: unknown): value is { _zod: { def: Record<string, unknown> } } {
  return (
    typeof value === 'object' &&
    value !== null &&
    '_zod' in value &&
    typeof (value as { _zod?: { def?: unknown } })._zod?.def === 'object'
  );
}

function isValibotSchema(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'schema' &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}

function isDirectJsonSchema(value: unknown): value is OpenApiSchemaObject {
  if (typeof value !== 'object' || value === null || '~standard' in value) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    typeof obj['type'] === 'string' ||
    Array.isArray(obj['type']) ||
    typeof obj['properties'] === 'object' ||
    Array.isArray(obj['anyOf']) ||
    Array.isArray(obj['oneOf']) ||
    Array.isArray(obj['allOf'])
  );
}

function reflectZodDef(
  schema: { _zod: { def: Record<string, unknown> } },
  depth: number,
  options: SchemaReflectOptions,
): OpenApiSchemaObject {
  const def = schema._zod.def;
  const kind = String(def['type'] ?? 'unknown');

  switch (kind) {
    case 'string': {
      const checks = Array.isArray(def['checks']) ? def['checks'] : [];
      const extra: Record<string, unknown> = {};
      for (const c of checks) {
        const cdef = (c as { _zod?: { def?: Record<string, unknown> }; def?: Record<string, unknown> })?._zod?.def ??
          (c as { def?: Record<string, unknown> })?.def;
        if (!cdef) continue;
        if (cdef['check'] === 'min_length' && typeof cdef['minimum'] === 'number') {
          extra['minLength'] = cdef['minimum'];
        } else if (cdef['check'] === 'max_length' && typeof cdef['maximum'] === 'number') {
          extra['maxLength'] = cdef['maximum'];
        } else if (cdef['format'] === 'email' || cdef['format'] === 'uuid' || cdef['format'] === 'url') {
          extra['format'] = cdef['format'];
        }
      }
      return { type: 'string', ...extra };
    }
    case 'number': {
      const checks = Array.isArray(def['checks']) ? def['checks'] : [];
      let isInt = false;
      const extra: Record<string, unknown> = {};
      for (const c of checks) {
        const cdef = (c as { _zod?: { def?: Record<string, unknown> }; def?: Record<string, unknown> })?._zod?.def ??
          (c as { def?: Record<string, unknown> })?.def;
        if (!cdef) continue;
        const fmt = cdef['format'];
        if (typeof fmt === 'string' && fmt.includes('int')) {
          isInt = true;
        }
        if (cdef['check'] === 'greater_than' && typeof cdef['value'] === 'number') {
          extra['minimum'] = cdef['value'];
        } else if (cdef['check'] === 'less_than' && typeof cdef['value'] === 'number') {
          extra['maximum'] = cdef['value'];
        }
      }
      return { type: isInt ? 'integer' : 'number', ...extra };
    }
    case 'int':
    case 'bigint':
      return { type: 'integer' };
    case 'boolean':
      return { type: 'boolean' };
    case 'null':
      return { type: 'null' };
    case 'literal': {
      const values = Array.isArray(def['values']) ? def['values'] : [def['value']];
      return values.length === 1 ? { const: values[0] } : { enum: values };
    }
    case 'enum': {
      const entries = def['entries'];
      const vals =
        entries && typeof entries === 'object'
          ? Object.values(entries as Record<string, unknown>)
          : [];
      return { type: 'string', enum: vals };
    }
    case 'array':
      return {
        type: 'array',
        items: reflectSchemaInternal(def['element'], depth + 1, options),
      };
    case 'object': {
      const shape = (def['shape'] ?? {}) as Record<string, unknown>;
      const properties: Record<string, OpenApiSchemaObject> = {};
      const required: string[] = [];
      for (const [key, propSchema] of Object.entries(shape)) {
        if (FORBIDDEN_KEYS.has(key)) continue;
        const unwrapped = isZodSchema(propSchema)
          ? unwrapZodOptional(propSchema as unknown as Record<string, unknown>)
          : { inner: propSchema, optional: false };
        properties[key] = reflectSchemaInternal(unwrapped.inner, depth + 1, options);
        if (!unwrapped.optional) {
          required.push(key);
        }
      }
      return {
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {}),
      };
    }
    case 'record':
      return {
        type: 'object',
        additionalProperties: reflectSchemaInternal(def['valueType'], depth + 1, options),
      };
    case 'union': {
      const opts = Array.isArray(def['options']) ? def['options'] : [];
      return {
        anyOf: opts.map((o) => reflectSchemaInternal(o, depth + 1, options)),
      };
    }
    case 'tuple': {
      const items = Array.isArray(def['items']) ? def['items'] : [];
      return {
        type: 'array',
        prefixItems: items.map((item) => reflectSchemaInternal(item, depth + 1, options)),
      };
    }
    case 'optional':
    case 'default':
    case 'prefault':
      return reflectSchemaInternal(def['innerType'], depth + 1, options);
    case 'nullable': {
      const inner = reflectSchemaInternal(def['innerType'], depth + 1, options);
      if (typeof inner.type === 'string') {
        return { ...inner, type: [inner.type, 'null'] };
      }
      return { anyOf: [inner, { type: 'null' }] };
    }
    default:
      return {};
  }
}

function reflectValibotSchema(
  schema: Record<string, unknown>,
  depth: number,
  options: SchemaReflectOptions,
): OpenApiSchemaObject {
  const kind = String(schema['type']);

  switch (kind) {
    case 'string':
      return { type: 'string' };
    case 'number':
      return { type: 'number' };
    case 'boolean':
      return { type: 'boolean' };
    case 'null':
      return { type: 'null' };
    case 'literal':
      return { const: schema['literal'] };
    case 'picklist': {
      const opts = Array.isArray(schema['options']) ? schema['options'] : [];
      return { type: 'string', enum: opts };
    }
    case 'enum': {
      const enumObj = schema['enum'];
      const vals =
        enumObj && typeof enumObj === 'object'
          ? Object.values(enumObj as Record<string, unknown>)
          : [];
      return { type: 'string', enum: vals };
    }
    case 'array':
      return {
        type: 'array',
        items: reflectSchemaInternal(schema['item'], depth + 1, options),
      };
    case 'object':
    case 'strict_object':
    case 'loose_object': {
      const entries = (schema['entries'] ?? {}) as Record<string, unknown>;
      const properties: Record<string, OpenApiSchemaObject> = {};
      const required: string[] = [];
      for (const [key, propSchema] of Object.entries(entries)) {
        if (FORBIDDEN_KEYS.has(key)) continue;
        const unwrapped = isValibotSchema(propSchema)
          ? unwrapValibotOptional(propSchema)
          : { inner: propSchema, optional: false };
        properties[key] = reflectSchemaInternal(unwrapped.inner, depth + 1, options);
        if (!unwrapped.optional) {
          required.push(key);
        }
      }
      return {
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {}),
      };
    }
    case 'record':
      return {
        type: 'object',
        additionalProperties: reflectSchemaInternal(schema['value'], depth + 1, options),
      };
    case 'union':
    case 'variant': {
      const opts = Array.isArray(schema['options']) ? schema['options'] : [];
      return {
        anyOf: opts.map((o) => reflectSchemaInternal(o, depth + 1, options)),
      };
    }
    case 'optional':
    case 'non_optional':
      return reflectSchemaInternal(schema['wrapped'], depth + 1, options);
    case 'nullable':
    case 'nullish': {
      const inner = reflectSchemaInternal(schema['wrapped'], depth + 1, options);
      if (typeof inner.type === 'string') {
        return { ...inner, type: [inner.type, 'null'] };
      }
      return { anyOf: [inner, { type: 'null' }] };
    }
    default: {
      if (Array.isArray(schema['pipe']) && schema['pipe'].length > 0) {
        return reflectSchemaInternal(schema['pipe'][0], depth + 1, options);
      }
      return {};
    }
  }
}

function reflectSchemaInternal(
  schema: unknown,
  depth: number,
  options: SchemaReflectOptions,
): OpenApiSchemaObject {
  const maxDepth = options.maxDepth ?? MAX_REFLECT_DEPTH;
  if (depth > maxDepth) {
    throw new OpenApiError(`Schema nesting depth exceeds maximum (${maxDepth})`, {
      statusCode: 400,
      expose: true,
    });
  }

  if (schema === undefined || schema === null) {
    return {};
  }

  if (options.customConverter) {
    const customConverted = options.customConverter(schema);
    if (customConverted !== undefined) {
      return sanitizeJsonSchema(customConverted);
    }
  }

  if (typeof schema === 'object') {
    const obj = schema as Record<string, unknown>;
    if (typeof obj['toJsonSchema'] === 'function') {
      return sanitizeJsonSchema((obj['toJsonSchema'] as () => OpenApiSchemaObject)());
    }
    if (typeof obj['toJSONSchema'] === 'function') {
      return sanitizeJsonSchema((obj['toJSONSchema'] as () => OpenApiSchemaObject)());
    }
    if (obj['jsonSchema'] && typeof obj['jsonSchema'] === 'object') {
      return sanitizeJsonSchema(obj['jsonSchema'] as OpenApiSchemaObject);
    }
  }

  if (isDirectJsonSchema(schema)) {
    return sanitizeJsonSchema(schema);
  }

  if (isZodSchema(schema)) {
    return sanitizeJsonSchema(reflectZodDef(schema, depth, options));
  }

  if (isValibotSchema(schema)) {
    return sanitizeJsonSchema(reflectValibotSchema(schema, depth, options));
  }

  return {};
}

export function schemaToJsonSchema(
  schema: unknown,
  options: SchemaReflectOptions = {},
): OpenApiSchemaObject {
  return reflectSchemaInternal(schema, 0, options);
}
