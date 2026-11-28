declare const CONTEXT_KEY_VALUE_TYPE: unique symbol;
declare const CONTEXT_KEY_HAS_DEFAULT: unique symbol;

const CONTEXT_KEY_BRAND = Symbol.for('forgejs.http.contextKey');

/**
 * Strongly typed, symbol-backed identifier for request-scoped state on `ForgeContext`.
 * Every call to `createContextKey()` creates a unique symbol identity so identical
 * labels from unrelated modules never collide.
 */
export interface ContextKey<T> {
  readonly id: symbol;
  readonly label: string;
  readonly hasDefault: false;
  readonly [CONTEXT_KEY_BRAND]: true;
  readonly [CONTEXT_KEY_VALUE_TYPE]?: T;
  readonly [CONTEXT_KEY_HAS_DEFAULT]?: false;
}

/**
 * Strongly typed, symbol-backed context key with a guaranteed default value or factory.
 * Calling `ctx.get(key)` on a `DefaultedContextKey<T>` always infers `T` (never `undefined`).
 */
export interface DefaultedContextKey<T> {
  readonly id: symbol;
  readonly label: string;
  readonly hasDefault: true;
  readonly defaultValue: () => T;
  readonly [CONTEXT_KEY_BRAND]: true;
  readonly [CONTEXT_KEY_VALUE_TYPE]?: T;
  readonly [CONTEXT_KEY_HAS_DEFAULT]?: true;
}

export type AnyContextKey<T = unknown> = ContextKey<T> | DefaultedContextKey<T>;

export interface ContextKeyOptions<T> {
  /** Default value or lazy factory used when `ctx.get(key)` is read before `ctx.set(key, value)`. */
  readonly defaultValue: T | (() => T);
}

export function createContextKey<T>(label: string): ContextKey<T>;
export function createContextKey<T>(
  label: string,
  options: ContextKeyOptions<T>,
): DefaultedContextKey<T>;
export function createContextKey<T>(
  label: string,
  options?: ContextKeyOptions<T>,
): ContextKey<T> | DefaultedContextKey<T> {
  const trimmed = label.trim();
  const normalizedLabel = trimmed.length > 0 ? trimmed : 'anonymous';
  const id = Symbol(normalizedLabel);

  if (options !== undefined && Object.prototype.hasOwnProperty.call(options, 'defaultValue')) {
    const rawDefault = options.defaultValue;
    const factory =
      typeof rawDefault === 'function'
        ? (rawDefault as () => T)
        : (): T => rawDefault;
    return Object.freeze({
      id,
      label: normalizedLabel,
      hasDefault: true as const,
      defaultValue: factory,
      [CONTEXT_KEY_BRAND]: true as const,
    });
  }

  return Object.freeze({
    id,
    label: normalizedLabel,
    hasDefault: false as const,
    [CONTEXT_KEY_BRAND]: true as const,
  });
}

export function isContextKey(value: unknown): value is AnyContextKey<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[CONTEXT_KEY_BRAND] === true &&
    typeof (value as { id?: unknown }).id === 'symbol'
  );
}
