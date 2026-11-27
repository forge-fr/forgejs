import { ValidationError } from '@forge-fr/core';
import fc from 'fast-check';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ResponseValidationError,
  createSchemaValidator,
  customSchema,
  fromStandardSchema,
  isStandardSchema,
  valibotAdapter,
  validate,
  validateOrThrow,
  zodAdapter,
} from '../src/index.js';

describe('@forge-fr/validation — Standard Schema v1 Engine & Adapters', () => {
  it('validates real Zod v4 schemas natively via Standard Schema v1 and via zodAdapter()', async () => {
    const UserSchema = z.object({
      email: z.string().email(),
      age: z.coerce.number().int().min(18),
    });

    expect(isStandardSchema(UserSchema)).toBe(true);

    const ok = await validate(UserSchema, { email: 'dev@forgejs.dev', age: '25' });
    expect(ok).toEqual({
      success: true,
      data: { email: 'dev@forgejs.dev', age: 25 },
    });

    const adapted = zodAdapter(UserSchema);
    const bad = await validate(adapted, { email: 'not-an-email', age: 12 });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.issues.length).toBeGreaterThanOrEqual(2);
      expect(bad.issues.map((i) => i.path.join('.'))).toEqual(
        expect.arrayContaining(['email', 'age']),
      );
    }
  });

  it('validates real Valibot v1 schemas natively via Standard Schema v1 and via valibotAdapter()', async () => {
    const ProductSchema = v.object({
      sku: v.pipe(v.string(), v.minLength(3)),
      price: v.pipe(v.number(), v.minValue(0)),
      tags: v.optional(v.array(v.string()), []),
    });

    expect(isStandardSchema(ProductSchema)).toBe(true);

    const adapted = valibotAdapter(ProductSchema);
    const ok = await validateOrThrow(adapted, { sku: 'FG-100', price: 49.5 });
    expect(ok).toEqual({ sku: 'FG-100', price: 49.5, tags: [] });

    await expect(
      validateOrThrow(ProductSchema, { sku: 'A', price: -5 }, { target: 'body' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('supports legacy Zod v3-style safeParseAsync schemas cleanly through zodAdapter()', async () => {
    const legacySchema = {
      async safeParseAsync(input: unknown) {
        if (typeof input === 'string' && input.length >= 2) {
          return { success: true as const, data: input.toUpperCase() };
        }
        return {
          success: false as const,
          error: {
            issues: [{ path: ['value'], message: 'Must be string of length >= 2', code: 'too_small' }],
          },
        };
      },
    };

    const adapted = zodAdapter(legacySchema);
    expect(await validateOrThrow(adapted, 'ok')).toBe('OK');

    const fail = await validate(adapted, 'x');
    expect(fail.success).toBe(false);
    if (!fail.success) {
      expect(fail.issues[0]).toEqual({
        path: ['value'],
        message: 'Must be string of length >= 2',
        code: 'too_small',
      });
    }
  });

  it('supports customSchema(), async validators, fromStandardSchema(), and createSchemaValidator()', async () => {
    const AsyncEvenNumber = customSchema<number>(async (input) => {
      await Promise.resolve();
      if (typeof input !== 'number' || !Number.isInteger(input) || input % 2 !== 0) {
        return { issues: [{ message: 'Expected an even integer', path: ['count'] }] };
      }
      return { value: input };
    });

    const validator = createSchemaValidator(fromStandardSchema(AsyncEvenNumber));
    expect(await validator.parse(4)).toBe(4);
    const bad = await validator.safeParse(3);
    expect(bad.success).toBe(false);
  });

  it('throws non-exposed ResponseValidationError (500) for response target failures so internal data never leaks', async () => {
    const OutputSchema = z.object({ id: z.string(), email: z.string().email() });

    let caught: unknown = null;
    try {
      await validateOrThrow(OutputSchema, { id: 123, secret: 'db_password_leak' }, { target: 'response' });
    } catch (err: unknown) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ResponseValidationError);
    const resErr = caught as ResponseValidationError;
    expect(resErr.statusCode).toBe(500);
    expect(resErr.expose).toBe(false);
    const pub = resErr.toPublicJSON({ production: true, requestId: 'req-1' });
    expect(pub.error.message).toBe('Internal Server Error');
    expect(JSON.stringify(pub)).not.toContain('db_password_leak');
  });

  it('property-based: never throws uncaught exceptions on arbitrary JSON-like inputs via validate()', async () => {
    const Schema = z.object({
      id: z.string().min(1),
      count: z.number().int().nonnegative(),
    });

    await fc.assert(
      fc.asyncProperty(fc.anything(), async (sample) => {
        const result = await validate(Schema, sample);
        expect(typeof result.success).toBe('boolean');
        if (!result.success) {
          expect(Array.isArray(result.issues)).toBe(true);
          expect(result.issues.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 100 },
    );
  });
});
