import type { StandardSchemaV1 } from '@standard-schema/spec';

export type { StandardSchemaV1 };

export type ValidationTarget = 'body' | 'query' | 'params' | 'headers' | 'response';

export interface ValidationIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
  readonly code?: string;
}

export interface ValidationSuccess<T> {
  readonly success: true;
  readonly data: T;
}

export interface ValidationFailure {
  readonly success: false;
  readonly issues: readonly ValidationIssue[];
}

export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;

export interface LegacySafeParseIssue {
  readonly path?: readonly (string | number)[];
  readonly message: string;
  readonly code?: string;
}

export interface LegacyZodLikeSchema<TOutput = unknown> {
  safeParseAsync(
    input: unknown,
  ): Promise<
    | { readonly success: true; readonly data: TOutput }
    | { readonly success: false; readonly error: { readonly issues: readonly LegacySafeParseIssue[] } }
  >;
}

export type AnySchema<TOutput = unknown, TInput = unknown> = StandardSchemaV1<TInput, TOutput>;

export type InferOutput<TSchema> = TSchema extends StandardSchemaV1<unknown, infer TOutput>
  ? TOutput
  : TSchema extends LegacyZodLikeSchema<infer TLegacyOutput>
    ? TLegacyOutput
    : unknown;

export type InferInput<TSchema> = TSchema extends StandardSchemaV1<infer TInput, unknown>
  ? TInput
  : unknown;

export interface ValidateOptions {
  readonly target?: ValidationTarget;
  readonly message?: string;
}

export interface RouteValidationSchemas<
  TBody extends AnySchema | undefined = AnySchema | undefined,
  TQuery extends AnySchema | undefined = AnySchema | undefined,
  TParams extends AnySchema | undefined = AnySchema | undefined,
  THeaders extends AnySchema | undefined = AnySchema | undefined,
  TResponse extends AnySchema | undefined = AnySchema | undefined,
> {
  readonly body?: TBody;
  readonly query?: TQuery;
  readonly params?: TParams;
  readonly headers?: THeaders;
  readonly response?: TResponse;
}

type InferSchemaField<TSchema> = [Exclude<TSchema, undefined>] extends [never]
  ? undefined
  : Exclude<TSchema, undefined> extends AnySchema
    ? InferOutput<Exclude<TSchema, undefined>>
    : undefined;

export interface ValidatedInput<TSchemas extends RouteValidationSchemas> {
  readonly body: InferSchemaField<TSchemas['body']>;
  readonly query: InferSchemaField<TSchemas['query']>;
  readonly params: InferSchemaField<TSchemas['params']>;
  readonly headers: InferSchemaField<TSchemas['headers']>;
}

export interface HttpValidationOptions {
  readonly maxBodyBytes?: number;
  readonly allowProtoKeys?: boolean;
  readonly validateNonJsonResponse?: boolean;
}
