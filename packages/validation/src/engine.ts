import { ForgeError, ValidationError, type ForgeErrorOptions } from '@forge-fr/core';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type {
  AnySchema,
  InferOutput,
  ValidateOptions,
  ValidationIssue,
  ValidationResult,
} from './types.js';

export class ResponseValidationError extends ForgeError {
  public constructor(
    message = 'Response failed schema validation',
    details?: Record<string, unknown>,
    options: Omit<ForgeErrorOptions, 'code' | 'statusCode' | 'details' | 'expose'> = {},
  ) {
    super(message, {
      ...options,
      code: 'RESPONSE_VALIDATION_ERROR',
      statusCode: 500,
      expose: false,
      ...(details !== undefined ? { details } : {}),
    });
  }
}

export function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return false;
  }
  const standard = (value as { readonly '~standard'?: unknown })['~standard'];
  if (typeof standard !== 'object' || standard === null) {
    return false;
  }
  const record = standard as { readonly version?: unknown; readonly validate?: unknown };
  return record.version === 1 && typeof record.validate === 'function';
}

function normalizePathSegment(segment: PropertyKey | StandardSchemaV1.PathSegment): string | number {
  const key =
    typeof segment === 'object' && segment !== null && 'key' in segment
      ? segment.key
      : segment;

  if (typeof key === 'number' || typeof key === 'string') {
    return key;
  }
  return String(key);
}

export function formatStandardIssues(
  issues: readonly StandardSchemaV1.Issue[],
): readonly ValidationIssue[] {
  return issues.map((issue) => {
    const path = issue.path ? issue.path.map(normalizePathSegment) : [];
    const codeCandidate = (issue as { readonly code?: unknown }).code;
    return {
      path,
      message: issue.message,
      ...(typeof codeCandidate === 'string' ? { code: codeCandidate } : {}),
    };
  });
}

export async function validate<TSchema extends AnySchema>(
  schema: TSchema,
  input: unknown,
): Promise<ValidationResult<InferOutput<TSchema>>> {
  if (!isStandardSchema(schema)) {
    return {
      success: false,
      issues: [{ path: [], message: 'Provided schema does not implement Standard Schema v1' }],
    };
  }

  let rawResult: StandardSchemaV1.Result<unknown>;
  try {
    rawResult = await schema['~standard'].validate(input);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Schema validation threw an unexpected error';
    return {
      success: false,
      issues: [{ path: [], message }],
    };
  }

  if (rawResult.issues) {
    return {
      success: false,
      issues: formatStandardIssues(rawResult.issues),
    };
  }

  return {
    success: true,
    data: rawResult.value as InferOutput<TSchema>,
  };
}

function throwValidationIssues(
  issues: readonly ValidationIssue[],
  options: ValidateOptions = {},
): never {
  const target = options.target ?? 'body';
  const details: Record<string, unknown> = {
    target,
    issues,
  };

  if (target === 'response') {
    throw new ResponseValidationError(
      options.message ?? 'Response payload failed schema validation',
      details,
    );
  }

  throw new ValidationError(
    options.message ?? `Validation failed for request ${target}`,
    details,
  );
}

export function validateOrThrowSyncOrAsync<TSchema extends AnySchema>(
  schema: TSchema,
  input: unknown,
  options: ValidateOptions = {},
): Promise<InferOutput<TSchema>> | InferOutput<TSchema> {
  if (!isStandardSchema(schema)) {
    throwValidationIssues(
      [{ path: [], message: 'Provided schema does not implement Standard Schema v1' }],
      options,
    );
  }

  let rawOrPromise: StandardSchemaV1.Result<unknown> | Promise<StandardSchemaV1.Result<unknown>>;
  try {
    rawOrPromise = schema['~standard'].validate(input);
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : 'Schema validation threw an unexpected error';
    throwValidationIssues([{ path: [], message }], options);
  }

  if (rawOrPromise instanceof Promise) {
    return rawOrPromise.then(
      (rawResult) => {
        if (rawResult.issues) {
          throwValidationIssues(formatStandardIssues(rawResult.issues), options);
        }
        return rawResult.value as InferOutput<TSchema>;
      },
      (err: unknown) => {
        const message =
          err instanceof Error ? err.message : 'Schema validation threw an unexpected error';
        throwValidationIssues([{ path: [], message }], options);
      },
    );
  }

  if (rawOrPromise.issues) {
    throwValidationIssues(formatStandardIssues(rawOrPromise.issues), options);
  }
  return rawOrPromise.value as InferOutput<TSchema>;
}

export async function validateOrThrow<TSchema extends AnySchema>(
  schema: TSchema,
  input: unknown,
  options: ValidateOptions = {},
): Promise<InferOutput<TSchema>> {
  return await validateOrThrowSyncOrAsync(schema, input, options);
}

interface ZodLikeSchema {
  readonly _zod: unknown;
  safeParse(input: unknown): { readonly success: true; readonly data: unknown } | {
    readonly success: false;
    readonly error: { readonly issues: readonly StandardSchemaV1.Issue[] };
  };
}

export function compileFastValidator<TSchema extends AnySchema>(
  schema: TSchema,
  options: ValidateOptions = {},
): (input: unknown) => Promise<InferOutput<TSchema>> | InferOutput<TSchema> {
  if (!isStandardSchema(schema)) {
    return () => {
      throwValidationIssues(
        [{ path: [], message: 'Provided schema does not implement Standard Schema v1' }],
        options,
      );
    };
  }

  const standardValidate = schema['~standard'].validate;
  const zodCandidate = schema as unknown as Partial<ZodLikeSchema>;
  if (zodCandidate._zod !== undefined && typeof zodCandidate.safeParse === 'function') {
    const zodSchema = schema as unknown as ZodLikeSchema;
    return (input: unknown): Promise<InferOutput<TSchema>> | InferOutput<TSchema> => {
      try {
        const res = zodSchema.safeParse(input);
        if (res.success) {
          return res.data as InferOutput<TSchema>;
        }
        throwValidationIssues(formatStandardIssues(res.error.issues), options);
      } catch (err: unknown) {
        if (err instanceof ValidationError || err instanceof ResponseValidationError) {
          throw err;
        }
        // Async refinements in Zod throw synchronously in safeParse; fall back to Standard Schema validate()
        return validateWithFn(standardValidate, input, options);
      }
    };
  }

  return (input: unknown): Promise<InferOutput<TSchema>> | InferOutput<TSchema> =>
    validateWithFn(standardValidate, input, options);
}

function validateWithFn<TOutput>(
  validateFn: StandardSchemaV1['~standard']['validate'],
  input: unknown,
  options: ValidateOptions,
): Promise<TOutput> | TOutput {
  let rawOrPromise: StandardSchemaV1.Result<unknown> | Promise<StandardSchemaV1.Result<unknown>>;
  try {
    rawOrPromise = validateFn(input);
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : 'Schema validation threw an unexpected error';
    throwValidationIssues([{ path: [], message }], options);
  }

  if (rawOrPromise instanceof Promise) {
    return rawOrPromise.then(
      (rawResult) => {
        if (rawResult.issues) {
          throwValidationIssues(formatStandardIssues(rawResult.issues), options);
        }
        return rawResult.value as TOutput;
      },
      (err: unknown) => {
        const message =
          err instanceof Error ? err.message : 'Schema validation threw an unexpected error';
        throwValidationIssues([{ path: [], message }], options);
      },
    );
  }

  if (rawOrPromise.issues) {
    throwValidationIssues(formatStandardIssues(rawOrPromise.issues), options);
  }
  return rawOrPromise.value as TOutput;
}

export interface SchemaValidator<TOutput> {
  safeParse(input: unknown): Promise<ValidationResult<TOutput>>;
  parse(input: unknown, options?: ValidateOptions): Promise<TOutput>;
}

export function createSchemaValidator<TSchema extends AnySchema>(
  schema: TSchema,
): SchemaValidator<InferOutput<TSchema>> {
  return {
    safeParse: (input: unknown) => validate(schema, input),
    parse: (input: unknown, options?: ValidateOptions) => validateOrThrow(schema, input, options),
  };
}
