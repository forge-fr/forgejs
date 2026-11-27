import type { StandardSchemaV1 } from '@standard-schema/spec';
import { isStandardSchema } from './engine.js';
import type { AnySchema, InferOutput, LegacyZodLikeSchema } from './types.js';

export type CustomValidateFn<TOutput> = (
  input: unknown,
) => Promise<StandardSchemaV1.Result<TOutput>> | StandardSchemaV1.Result<TOutput>;

export function customSchema<TOutput, TInput = unknown>(
  validateFn: CustomValidateFn<TOutput>,
  vendor = 'forgejs-custom',
): StandardSchemaV1<TInput, TOutput> {
  return {
    '~standard': {
      version: 1,
      vendor,
      validate: (value: unknown) => validateFn(value),
    },
  };
}

export function fromStandardSchema<TSchema extends AnySchema>(schema: TSchema): TSchema {
  if (!isStandardSchema(schema)) {
    throw new TypeError('Expected a Standard Schema v1 compliant schema');
  }
  return schema;
}

/**
 * Adapts a Zod v4 (Standard Schema v1 native) or legacy Zod v3 (`safeParseAsync`)
 * schema into a unified Standard Schema v1 contract with zero runtime import of `zod`.
 */
export function zodAdapter<TSchema extends AnySchema | LegacyZodLikeSchema>(
  schema: TSchema,
): StandardSchemaV1<unknown, InferOutput<TSchema>> {
  if (isStandardSchema(schema)) {
    return schema as StandardSchemaV1<unknown, InferOutput<TSchema>>;
  }

  if (
    typeof schema === 'object' &&
    schema !== null &&
    'safeParseAsync' in schema &&
    typeof schema.safeParseAsync === 'function'
  ) {
    const legacy = schema as LegacyZodLikeSchema<InferOutput<TSchema>>;
    return {
      '~standard': {
        version: 1,
        vendor: 'zod',
        async validate(value: unknown) {
          const result = await legacy.safeParseAsync(value);
          if (result.success) {
            return { value: result.data };
          }
          return {
            issues: result.error.issues.map((issue) => ({
              message: issue.message,
              ...(issue.path !== undefined ? { path: issue.path } : {}),
              ...(issue.code !== undefined ? { code: issue.code } : {}),
            })),
          };
        },
      },
    };
  }

  throw new TypeError(
    'zodAdapter() expects a Zod v4 (Standard Schema v1) or Zod v3 schema with safeParseAsync()',
  );
}

/**
 * Adapts a Valibot v1 (Standard Schema v1 native) schema with zero runtime import of `valibot`.
 */
export function valibotAdapter<TSchema extends AnySchema>(
  schema: TSchema,
): StandardSchemaV1<unknown, InferOutput<TSchema>> {
  if (!isStandardSchema(schema)) {
    throw new TypeError('valibotAdapter() expects a Valibot v1 (Standard Schema v1) schema');
  }
  return schema as StandardSchemaV1<unknown, InferOutput<TSchema>>;
}
