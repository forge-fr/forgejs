const SECRET_BRAND: unique symbol = Symbol.for('@forge-fr/core.SecretValue');
export const REDACTED_PLACEHOLDER = '[REDACTED]';

export interface SecretValue<T = string> {
  readonly [SECRET_BRAND]: true;
  reveal(): T;
  toString(): string;
  toJSON(): string;
}

class MaskedSecret<T> implements SecretValue<T> {
  public readonly [SECRET_BRAND] = true as const;
  readonly #value: T;

  public constructor(value: T) {
    this.#value = value;
    Object.freeze(this);
  }

  public reveal(): T {
    return this.#value;
  }

  public toString(): string {
    return REDACTED_PLACEHOLDER;
  }

  public toJSON(): string {
    return REDACTED_PLACEHOLDER;
  }

  public valueOf(): string {
    return REDACTED_PLACEHOLDER;
  }
}

export function secret<T = string>(value: T): SecretValue<T> {
  return new MaskedSecret(value);
}

export function isSecretValue(value: unknown): value is SecretValue<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    SECRET_BRAND in value &&
    (value as Record<symbol, unknown>)[SECRET_BRAND] === true
  );
}
