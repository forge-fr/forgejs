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

function extractSafeDefaultValue(rawDefault: unknown): unknown {
  try {
    const evaluated = typeof rawDefault === 'function' ? (rawDefault as () => unknown)() : rawDefault;
    if (
      evaluated === null ||
      typeof evaluated === 'string' ||
      typeof evaluated === 'number' ||
      typeof evaluated === 'boolean'
    ) {
      return evaluated;
    }
    if (Array.isArray(evaluated) || (typeof evaluated === 'object' && evaluated !== null)) {
      if (evaluated instanceof Date) {
        return evaluated.toISOString();
      }
      return JSON.parse(JSON.stringify(evaluated)) as unknown;
    }
  } catch {
    // Ignore non-deterministic or throwing default value factories during static reflection
  }
  return undefined;
}

function getZodDef(schema: unknown): Record<string, unknown> | undefined {
  if (typeof schema !== 'object' || schema === null) {
    return undefined;
  }
  const v4Def = (schema as { _zod?: { def?: unknown } })._zod?.def;
  if (typeof v4Def === 'object' && v4Def !== null) {
    return v4Def as Record<string, unknown>;
  }
  const v3Def = (schema as { _def?: unknown })._def;
  if (typeof v3Def === 'object' && v3Def !== null) {
    return v3Def as Record<string, unknown>;
  }
  return undefined;
}

function normalizeZodKind(def: Record<string, unknown>): string {
  if (typeof def['type'] === 'string') {
    return def['type'];
  }
  const typeName = def['typeName'];
  if (typeof typeName === 'string') {
    switch (typeName) {
      case 'ZodString':
        return 'string';
      case 'ZodNumber':
        return 'number';
      case 'ZodBigInt':
        return 'bigint';
      case 'ZodBoolean':
        return 'boolean';
      case 'ZodDate':
        return 'date';
      case 'ZodNull':
        return 'null';
      case 'ZodLiteral':
        return 'literal';
      case 'ZodEnum':
      case 'ZodNativeEnum':
        return 'enum';
      case 'ZodArray':
        return 'array';
      case 'ZodObject':
        return 'object';
      case 'ZodRecord':
        return 'record';
      case 'ZodUnion':
        return 'union';
      case 'ZodDiscriminatedUnion':
        return 'discriminatedUnion';
      case 'ZodIntersection':
        return 'intersection';
      case 'ZodTuple':
        return 'tuple';
      case 'ZodOptional':
        return 'optional';
      case 'ZodDefault':
        return 'default';
      case 'ZodNullable':
        return 'nullable';
      case 'ZodEffects':
        return 'effects';
      case 'ZodPipeline':
        return 'pipe';
      case 'ZodReadonly':
      case 'ZodBranded':
      case 'ZodCatch':
        return 'wrapper';
      default:
        return typeName;
    }
  }
  return 'unknown';
}

function extractSchemaDescription(schema: unknown, def?: Record<string, unknown>): string | undefined {
  if (typeof schema === 'object' && schema !== null) {
    const direct = (schema as { description?: unknown }).description;
    if (typeof direct === 'string' && direct.length > 0) {
      return direct;
    }
  }
  if (def && typeof def['description'] === 'string' && def['description'].length > 0) {
    return def['description'];
  }
  return undefined;
}

function unwrapZodOptional(schema: Record<string, unknown>): {
  readonly inner: unknown;
  readonly optional: boolean;
  readonly defaultValue?: unknown;
  readonly description?: string;
} {
  let current: unknown = schema;
  let optional = false;
  let defaultValue: unknown;
  let description = extractSchemaDescription(schema, getZodDef(schema));

  for (let i = 0; i < 8; i += 1) {
    const def = getZodDef(current);
    if (!def) break;
    description = description ?? extractSchemaDescription(current, def);
    const t = normalizeZodKind(def);
    if (t === 'optional' || t === 'default' || t === 'prefault') {
      optional = true;
      if ((t === 'default' || t === 'prefault') && 'defaultValue' in def && defaultValue === undefined) {
        defaultValue = extractSafeDefaultValue(def['defaultValue']);
      }
      current = def['innerType'] ?? def['schema'];
    } else {
      break;
    }
  }
  return {
    inner: current,
    optional,
    ...(defaultValue !== undefined ? { defaultValue } : {}),
    ...(description !== undefined ? { description } : {}),
  };
}

function unwrapValibotOptional(schema: Record<string, unknown>): {
  readonly inner: unknown;
  readonly optional: boolean;
  readonly defaultValue?: unknown;
} {
  let current: unknown = schema;
  let optional = false;
  let defaultValue: unknown;

  for (let i = 0; i < 8; i += 1) {
    const s = current as { kind?: unknown; type?: unknown; wrapped?: unknown; default?: unknown };
    if (s?.kind !== 'schema') break;
    if (s.type === 'optional' || s.type === 'nullish' || s.type === 'exact_optional') {
      optional = true;
      if (s.default !== undefined && defaultValue === undefined) {
        defaultValue = extractSafeDefaultValue(s.default);
      }
      current = s.wrapped;
    } else {
      break;
    }
  }
  return {
    inner: current,
    optional,
    ...(defaultValue !== undefined ? { defaultValue } : {}),
  };
}

function isZodSchema(value: unknown): value is Record<string, unknown> {
  return getZodDef(value) !== undefined;
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

function normalizeStringFormat(fmt: string): string | undefined {
  switch (fmt) {
    case 'email':
    case 'uuid':
    case 'url':
    case 'uri':
    case 'date':
    case 'time':
    case 'ipv4':
    case 'ipv6':
    case 'cuid':
    case 'cuid2':
    case 'ulid':
      return fmt === 'url' ? 'uri' : fmt;
    case 'datetime':
    case 'date-time':
    case 'iso_date_time':
    case 'iso_timestamp':
      return 'date-time';
    case 'iso_date':
      return 'date';
    case 'iso_time':
      return 'time';
    default:
      return undefined;
  }
}

function reflectZodDef(
  schema: Record<string, unknown>,
  depth: number,
  options: SchemaReflectOptions,
): OpenApiSchemaObject {
  const def = getZodDef(schema) ?? {};
  const kind = normalizeZodKind(def);
  const description = extractSchemaDescription(schema, def);
  const withMeta = (obj: OpenApiSchemaObject): OpenApiSchemaObject =>
    description !== undefined && obj.description === undefined ? { ...obj, description } : obj;

  switch (kind) {
    case 'string': {
      const checks = Array.isArray(def['checks']) ? def['checks'] : [];
      const extra: Record<string, unknown> = {};
      if (typeof def['format'] === 'string') {
        if (def['format'] === 'email' || def['format'] === 'uuid' || def['format'] === 'url') {
          extra['format'] = def['format'];
        } else {
          const mapped = normalizeStringFormat(def['format']);
          if (mapped) extra['format'] = mapped;
        }
      }
      if (def['pattern'] instanceof RegExp && extra['format'] === undefined) {
        extra['pattern'] = def['pattern'].source;
      }

      for (const c of checks) {
        const cdef =
          (c as { _zod?: { def?: Record<string, unknown> }; def?: Record<string, unknown> })?._zod
            ?.def ??
          (c as { def?: Record<string, unknown> })?.def ??
          (typeof c === 'object' && c !== null ? (c as Record<string, unknown>) : undefined);
        if (!cdef) continue;

        const checkKind = cdef['check'] ?? cdef['kind'];
        if (checkKind === 'min_length' && typeof cdef['minimum'] === 'number') {
          extra['minLength'] = cdef['minimum'];
        } else if (checkKind === 'min' && typeof cdef['value'] === 'number') {
          extra['minLength'] = cdef['value'];
        } else if (checkKind === 'max_length' && typeof cdef['maximum'] === 'number') {
          extra['maxLength'] = cdef['maximum'];
        } else if (checkKind === 'max' && typeof cdef['value'] === 'number') {
          extra['maxLength'] = cdef['value'];
        } else if (checkKind === 'length_equals' && typeof cdef['length'] === 'number') {
          extra['minLength'] = cdef['length'];
          extra['maxLength'] = cdef['length'];
        } else if (checkKind === 'length' && typeof cdef['value'] === 'number') {
          extra['minLength'] = cdef['value'];
          extra['maxLength'] = cdef['value'];
        } else if (
          cdef['format'] === 'email' ||
          cdef['format'] === 'uuid' ||
          cdef['format'] === 'url'
        ) {
          extra['format'] = cdef['format'];
        } else if (typeof cdef['format'] === 'string') {
          if (cdef['format'] === 'regex' && cdef['pattern'] instanceof RegExp) {
            extra['pattern'] = cdef['pattern'].source;
          } else {
            const mapped = normalizeStringFormat(cdef['format']);
            if (mapped) extra['format'] = mapped;
          }
        } else if (typeof checkKind === 'string') {
          if (checkKind === 'regex' && cdef['regex'] instanceof RegExp) {
            extra['pattern'] = cdef['regex'].source;
          } else {
            const mapped = normalizeStringFormat(checkKind);
            if (mapped) extra['format'] = mapped;
          }
        }
      }
      return withMeta({ type: 'string', ...extra });
    }
    case 'number': {
      const checks = Array.isArray(def['checks']) ? def['checks'] : [];
      let isInt = false;
      const extra: Record<string, unknown> = {};
      for (const c of checks) {
        const cdef =
          (c as { _zod?: { def?: Record<string, unknown> }; def?: Record<string, unknown> })?._zod
            ?.def ??
          (c as { def?: Record<string, unknown> })?.def ??
          (typeof c === 'object' && c !== null ? (c as Record<string, unknown>) : undefined);
        if (!cdef) continue;
        const fmt = cdef['format'];
        const checkKind = cdef['check'] ?? cdef['kind'];
        if ((typeof fmt === 'string' && fmt.includes('int')) || checkKind === 'int') {
          isInt = true;
        }
        if ((checkKind === 'greater_than' || checkKind === 'min') && typeof cdef['value'] === 'number') {
          if (cdef['inclusive'] === false) {
            extra['exclusiveMinimum'] = cdef['value'];
          } else {
            extra['minimum'] = cdef['value'];
          }
        } else if (
          (checkKind === 'less_than' || checkKind === 'max') &&
          typeof cdef['value'] === 'number'
        ) {
          if (cdef['inclusive'] === false) {
            extra['exclusiveMaximum'] = cdef['value'];
          } else {
            extra['maximum'] = cdef['value'];
          }
        } else if (
          (checkKind === 'multiple_of' || checkKind === 'multipleOf') &&
          typeof cdef['value'] === 'number'
        ) {
          extra['multipleOf'] = cdef['value'];
        }
      }
      return withMeta({ type: isInt ? 'integer' : 'number', ...extra });
    }
    case 'int':
    case 'bigint':
      return withMeta({ type: 'integer' });
    case 'boolean':
      return withMeta({ type: 'boolean' });
    case 'date':
      return withMeta({ type: 'string', format: 'date-time' });
    case 'null':
      return withMeta({ type: 'null' });
    case 'literal': {
      const values = Array.isArray(def['values']) ? def['values'] : [def['value']];
      return withMeta(values.length === 1 ? { const: values[0] } : { enum: values });
    }
    case 'enum': {
      const entries = def['entries'] ?? def['values'];
      const vals = Array.isArray(entries)
        ? entries
        : entries && typeof entries === 'object'
          ? Object.values(entries as Record<string, unknown>)
          : [];
      return withMeta({ type: 'string', enum: vals });
    }
    case 'array': {
      const checks = Array.isArray(def['checks']) ? def['checks'] : [];
      const extra: Record<string, unknown> = {};
      for (const c of checks) {
        const cdef =
          (c as { _zod?: { def?: Record<string, unknown> }; def?: Record<string, unknown> })?._zod
            ?.def ??
          (c as { def?: Record<string, unknown> })?.def ??
          (typeof c === 'object' && c !== null ? (c as Record<string, unknown>) : undefined);
        if (!cdef) continue;
        const checkKind = cdef['check'] ?? cdef['kind'];
        if (checkKind === 'min_length' && typeof cdef['minimum'] === 'number') {
          extra['minItems'] = cdef['minimum'];
        } else if (checkKind === 'max_length' && typeof cdef['maximum'] === 'number') {
          extra['maxItems'] = cdef['maximum'];
        } else if (checkKind === 'length_equals' && typeof cdef['length'] === 'number') {
          extra['minItems'] = cdef['length'];
          extra['maxItems'] = cdef['length'];
        }
      }
      const v3Min = (def['minLength'] as { value?: unknown } | undefined)?.value;
      const v3Max = (def['maxLength'] as { value?: unknown } | undefined)?.value;
      const v3Exact = (def['exactLength'] as { value?: unknown } | undefined)?.value;
      if (typeof v3Min === 'number') extra['minItems'] = v3Min;
      if (typeof v3Max === 'number') extra['maxItems'] = v3Max;
      if (typeof v3Exact === 'number') {
        extra['minItems'] = v3Exact;
        extra['maxItems'] = v3Exact;
      }
      const elementSchema = def['element'] ?? def['type'];
      return withMeta({
        type: 'array',
        items: reflectSchemaInternal(elementSchema, depth + 1, options),
        ...extra,
      });
    }
    case 'object': {
      const rawShape = def['shape'];
      const shape = (typeof rawShape === 'function' ? rawShape() : rawShape ?? {}) as Record<
        string,
        unknown
      >;
      const properties: Record<string, OpenApiSchemaObject> = {};
      const required: string[] = [];
      for (const [key, propSchema] of Object.entries(shape)) {
        if (FORBIDDEN_KEYS.has(key)) continue;
        const unwrapped = isZodSchema(propSchema)
          ? unwrapZodOptional(propSchema)
          : { inner: propSchema, optional: false };
        let reflectedProp = reflectSchemaInternal(unwrapped.inner, depth + 1, options);
        if (unwrapped.defaultValue !== undefined && reflectedProp.default === undefined) {
          reflectedProp = { ...reflectedProp, default: unwrapped.defaultValue };
        }
        if (unwrapped.description !== undefined && reflectedProp.description === undefined) {
          reflectedProp = { ...reflectedProp, description: unwrapped.description };
        }
        properties[key] = reflectedProp;
        if (!unwrapped.optional) {
          required.push(key);
        }
      }
      return withMeta({
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {}),
      });
    }
    case 'record':
      return withMeta({
        type: 'object',
        additionalProperties: reflectSchemaInternal(def['valueType'], depth + 1, options),
      });
    case 'discriminatedUnion':
    case 'union': {
      const rawOptions = def['options'];
      const opts = Array.isArray(rawOptions)
        ? rawOptions
        : rawOptions instanceof Map
          ? Array.from(rawOptions.values())
          : [];
      const discriminator =
        typeof def['discriminator'] === 'string' && def['discriminator'].length > 0
          ? def['discriminator']
          : undefined;
      if (discriminator !== undefined) {
        return withMeta({
          oneOf: opts.map((o) => reflectSchemaInternal(o, depth + 1, options)),
          discriminator: { propertyName: discriminator },
        });
      }
      return withMeta({
        anyOf: opts.map((o) => reflectSchemaInternal(o, depth + 1, options)),
      });
    }
    case 'intersection': {
      const left = reflectSchemaInternal(def['left'], depth + 1, options);
      const right = reflectSchemaInternal(def['right'], depth + 1, options);
      return withMeta({
        allOf: [left, right],
      });
    }
    case 'tuple': {
      const items = Array.isArray(def['items']) ? def['items'] : [];
      return withMeta({
        type: 'array',
        prefixItems: items.map((item) => reflectSchemaInternal(item, depth + 1, options)),
      });
    }
    case 'optional':
    case 'wrapper':
      return withMeta(reflectSchemaInternal(def['innerType'] ?? def['type'], depth + 1, options));
    case 'default':
    case 'prefault': {
      const inner = reflectSchemaInternal(def['innerType'], depth + 1, options);
      const defaultVal = extractSafeDefaultValue(def['defaultValue']);
      return withMeta(
        defaultVal !== undefined && inner.default === undefined
          ? { ...inner, default: defaultVal }
          : inner,
      );
    }
    case 'nullable': {
      const inner = reflectSchemaInternal(def['innerType'], depth + 1, options);
      if (typeof inner.type === 'string') {
        return withMeta({ ...inner, type: [inner.type, 'null'] });
      }
      return withMeta({ anyOf: [inner, { type: 'null' }] });
    }
    case 'pipe': {
      const inSchema = def['in'];
      const outSchema = def['out'];
      const inDef = getZodDef(inSchema);
      if (inDef && normalizeZodKind(inDef) !== 'transform') {
        return withMeta(reflectSchemaInternal(inSchema, depth + 1, options));
      }
      return withMeta(reflectSchemaInternal(outSchema, depth + 1, options));
    }
    case 'effects':
      return withMeta(reflectSchemaInternal(def['schema'], depth + 1, options));
    default:
      return withMeta({});
  }
}

function applyValibotPipeActions(
  base: OpenApiSchemaObject,
  pipe: readonly unknown[],
): OpenApiSchemaObject {
  const extra: Record<string, unknown> = {};
  for (let i = 1; i < pipe.length; i += 1) {
    const item = pipe[i];
    if (typeof item !== 'object' || item === null) continue;
    const action = item as Record<string, unknown>;
    const actionType = String(action['type'] ?? '');
    const requirement = action['requirement'];

    switch (actionType) {
      case 'description': {
        const desc = action['description'] ?? requirement;
        if (typeof desc === 'string') extra['description'] = desc;
        break;
      }
      case 'title': {
        const title = action['title'] ?? requirement;
        if (typeof title === 'string') extra['title'] = title;
        break;
      }
      case 'min_length':
        if (typeof requirement === 'number') {
          extra[base.type === 'array' ? 'minItems' : 'minLength'] = requirement;
        }
        break;
      case 'max_length':
        if (typeof requirement === 'number') {
          extra[base.type === 'array' ? 'maxItems' : 'maxLength'] = requirement;
        }
        break;
      case 'length':
        if (typeof requirement === 'number') {
          if (base.type === 'array') {
            extra['minItems'] = requirement;
            extra['maxItems'] = requirement;
          } else {
            extra['minLength'] = requirement;
            extra['maxLength'] = requirement;
          }
        }
        break;
      case 'min_value':
        if (typeof requirement === 'number') extra['minimum'] = requirement;
        break;
      case 'max_value':
        if (typeof requirement === 'number') extra['maximum'] = requirement;
        break;
      case 'multiple_of':
        if (typeof requirement === 'number') extra['multipleOf'] = requirement;
        break;
      case 'integer':
      case 'safe_integer':
        if (base.type === 'number') extra['type'] = 'integer';
        break;
      case 'regex':
        if (requirement instanceof RegExp) extra['pattern'] = requirement.source;
        break;
      case 'email':
      case 'uuid':
      case 'url':
        extra['format'] = actionType;
        break;
      default: {
        const mappedFmt = normalizeStringFormat(actionType);
        if (mappedFmt) {
          extra['format'] = mappedFmt;
        }
        break;
      }
    }
  }
  return Object.keys(extra).length > 0 ? { ...base, ...extra } : base;
}

function reflectValibotSchema(
  schema: Record<string, unknown>,
  depth: number,
  options: SchemaReflectOptions,
): OpenApiSchemaObject {
  const kind = String(schema['type']);
  let base: OpenApiSchemaObject;

  switch (kind) {
    case 'string':
      base = { type: 'string' };
      break;
    case 'number':
      base = { type: 'number' };
      break;
    case 'bigint':
      base = { type: 'integer' };
      break;
    case 'boolean':
      base = { type: 'boolean' };
      break;
    case 'date':
      base = { type: 'string', format: 'date-time' };
      break;
    case 'null':
      base = { type: 'null' };
      break;
    case 'literal':
      base = { const: schema['literal'] };
      break;
    case 'picklist': {
      const opts = Array.isArray(schema['options']) ? schema['options'] : [];
      base = { type: 'string', enum: opts };
      break;
    }
    case 'enum': {
      const enumObj = schema['enum'];
      const vals =
        enumObj && typeof enumObj === 'object'
          ? Object.values(enumObj as Record<string, unknown>)
          : [];
      base = { type: 'string', enum: vals };
      break;
    }
    case 'array':
      base = {
        type: 'array',
        items: reflectSchemaInternal(schema['item'], depth + 1, options),
      };
      break;
    case 'tuple': {
      const items = Array.isArray(schema['items']) ? schema['items'] : [];
      base = {
        type: 'array',
        prefixItems: items.map((item) => reflectSchemaInternal(item, depth + 1, options)),
      };
      break;
    }
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
        let reflectedProp = reflectSchemaInternal(unwrapped.inner, depth + 1, options);
        if (unwrapped.defaultValue !== undefined && reflectedProp.default === undefined) {
          reflectedProp = { ...reflectedProp, default: unwrapped.defaultValue };
        }
        properties[key] = reflectedProp;
        if (!unwrapped.optional) {
          required.push(key);
        }
      }
      base = {
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {}),
      };
      break;
    }
    case 'record':
      base = {
        type: 'object',
        additionalProperties: reflectSchemaInternal(schema['value'], depth + 1, options),
      };
      break;
    case 'variant': {
      const opts = Array.isArray(schema['options']) ? schema['options'] : [];
      const discriminatorKey =
        typeof schema['key'] === 'string' && schema['key'].length > 0 ? schema['key'] : undefined;
      base = {
        oneOf: opts.map((o) => reflectSchemaInternal(o, depth + 1, options)),
        ...(discriminatorKey !== undefined
          ? { discriminator: { propertyName: discriminatorKey } }
          : {}),
      };
      break;
    }
    case 'union': {
      const opts = Array.isArray(schema['options']) ? schema['options'] : [];
      base = {
        anyOf: opts.map((o) => reflectSchemaInternal(o, depth + 1, options)),
      };
      break;
    }
    case 'intersect': {
      const opts = Array.isArray(schema['options']) ? schema['options'] : [];
      base = {
        allOf: opts.map((o) => reflectSchemaInternal(o, depth + 1, options)),
      };
      break;
    }
    case 'optional':
    case 'exact_optional':
    case 'non_optional': {
      const inner = reflectSchemaInternal(schema['wrapped'], depth + 1, options);
      const defaultVal =
        schema['default'] !== undefined ? extractSafeDefaultValue(schema['default']) : undefined;
      base =
        defaultVal !== undefined && inner.default === undefined
          ? { ...inner, default: defaultVal }
          : inner;
      break;
    }
    case 'nullable':
    case 'nullish': {
      const inner = reflectSchemaInternal(schema['wrapped'], depth + 1, options);
      if (typeof inner.type === 'string') {
        base = { ...inner, type: [inner.type, 'null'] };
      } else {
        base = { anyOf: [inner, { type: 'null' }] };
      }
      break;
    }
    default: {
      if (Array.isArray(schema['pipe']) && schema['pipe'].length > 0 && schema['pipe'][0] !== schema) {
        base = reflectSchemaInternal(schema['pipe'][0], depth + 1, options);
      } else {
        base = {};
      }
      break;
    }
  }

  if (Array.isArray(schema['pipe']) && schema['pipe'].length > 1) {
    return applyValibotPipeActions(base, schema['pipe']);
  }
  return base;
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
    if (obj['jsonSchema'] && typeof obj['jsonSchema'] === 'object') {
      return sanitizeJsonSchema(obj['jsonSchema'] as OpenApiSchemaObject);
    }
  }

  if (isZodSchema(schema)) {
    return sanitizeJsonSchema(reflectZodDef(schema, depth, options));
  }

  if (isValibotSchema(schema)) {
    return sanitizeJsonSchema(reflectValibotSchema(schema, depth, options));
  }

  if (typeof schema === 'object') {
    const obj = schema as Record<string, unknown>;
    if (typeof obj['toJsonSchema'] === 'function') {
      return sanitizeJsonSchema((obj['toJsonSchema'] as () => OpenApiSchemaObject)());
    }
    if (typeof obj['toJSONSchema'] === 'function') {
      return sanitizeJsonSchema((obj['toJSONSchema'] as () => OpenApiSchemaObject)());
    }
  }

  if (isDirectJsonSchema(schema)) {
    return sanitizeJsonSchema(schema);
  }

  return {};
}

export function schemaToJsonSchema(
  schema: unknown,
  options: SchemaReflectOptions = {},
): OpenApiSchemaObject {
  return reflectSchemaInternal(schema, 0, options);
}
