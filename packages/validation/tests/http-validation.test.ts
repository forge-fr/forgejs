import { createNoopLogger } from '@forge-fr/core';
import { createHttpApp } from '@forge-fr/http';
import { createTestClient } from '@forge-fr/testing';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { getValidated, validateRequest, validatedHandler } from '../src/index.js';

describe('@forge-fr/validation — HTTP Route Validation (Body, Query, Params, Headers & Response)', () => {
  it('validates params, query, headers, and JSON body with full inference via validatedHandler() using Zod & Valibot together', async () => {
    const app = createHttpApp({ logger: createNoopLogger() });

    app.post(
      '/orgs/:orgId/members',
      validatedHandler(
        {
          params: z.object({ orgId: z.string().regex(/^org_[0-9]+$/) }),
          query: v.object({
            notify: v.optional(
              v.pipe(
                v.string(),
                v.transform((s) => s === 'true'),
              ),
              'false',
            ),
          }),
          headers: z.object({ 'x-tenant': z.string().min(2) }),
          body: z.object({
            name: z.string().min(2),
            role: z.enum(['admin', 'member']),
          }),
          response: z.object({
            orgId: z.string(),
            name: z.string(),
            role: z.string(),
            notify: z.boolean(),
            tenant: z.string(),
          }),
        },
        (ctx, input) => {
          // Intentionally include an extra sensitive field to verify response schema strips it
          return ctx.status(201).json({
            orgId: input.params.orgId,
            name: input.body.name,
            role: input.body.role,
            notify: input.query.notify,
            tenant: input.headers['x-tenant'],
            internalSecretHash: 'argon2id$should-be-stripped',
          });
        },
      ),
    );

    const client = createTestClient(app);

    const okRes = await client.post('/orgs/org_42/members', {
      query: { notify: 'true' },
      headers: { 'x-tenant': 'acme' },
      json: { name: 'Budi', role: 'admin' },
    });

    expect(okRes.status).toBe(201);
    const okData = (await okRes.json()) as Record<string, unknown>;
    expect(okData).toEqual({
      orgId: 'org_42',
      name: 'Budi',
      role: 'admin',
      notify: true,
      tenant: 'acme',
    });
    expect('internalSecretHash' in okData).toBe(false);

    // Invalid body returns structured 400 VALIDATION_ERROR with path issues
    const badBody = await client.post('/orgs/org_42/members', {
      headers: { 'x-tenant': 'acme' },
      json: { name: 'B', role: 'superroot' },
    });
    expect(badBody.status).toBe(400);
    const badJson = (await badBody.json()) as {
      error: { code: string; details: { target: string; issues: { path: string[] }[] } };
    };
    expect(badJson.error.code).toBe('VALIDATION_ERROR');
    expect(badJson.error.details.target).toBe('body');
    expect(badJson.error.details.issues.length).toBeGreaterThanOrEqual(2);

    // Invalid params returns 400 VALIDATION_ERROR with target: "params"
    const badParams = await client.post('/orgs/invalid/members', {
      headers: { 'x-tenant': 'acme' },
      json: { name: 'Budi', role: 'member' },
    });
    expect(badParams.status).toBe(400);
    const badParamsJson = (await badParams.json()) as {
      error: { details: { target: string } };
    };
    expect(badParamsJson.error.details.target).toBe('params');

    await client.close();
  });

  it('works as route middleware via validateRequest() + getValidated(ctx) and sanitizes response contract violations in production', async () => {
    const app = createHttpApp({ production: true, logger: createNoopLogger() });

    const SearchQuery = z.object({
      q: z.string().min(1),
      page: z.coerce.number().int().min(1).default(1),
    });

    app.get(
      '/search',
      (ctx) => {
        const { query } = getValidated<{ query: z.infer<typeof SearchQuery> }>(ctx);
        return ctx.json({ query: query.q, page: query.page });
      },
      { middleware: [validateRequest({ query: SearchQuery })] },
    );

    // Route whose handler violates its response schema must fail closed (500 sanitized)
    app.get(
      '/broken-contract',
      validatedHandler(
        {
          response: z.object({ id: z.string(), active: z.boolean() }),
        },
        (ctx) => ctx.json({ id: 999, leak: 'top-secret-db-row' }),
      ),
    );

    const client = createTestClient(app);

    const searchRes = await client.get('/search', { query: { q: 'forge', page: '3' } });
    expect(searchRes.status).toBe(200);
    expect(await searchRes.json()).toEqual({ query: 'forge', page: 3 });

    const brokenRes = await client.get('/broken-contract');
    expect(brokenRes.status).toBe(500);
    const brokenBody = (await brokenRes.json()) as {
      error: { code: string; message: string };
    };
    expect(brokenBody.error.code).toBe('RESPONSE_VALIDATION_ERROR');
    expect(brokenBody.error.message).toBe('Internal Server Error');
    expect(JSON.stringify(brokenBody)).not.toContain('top-secret-db-row');

    await client.close();
  });

  it('enforces bounded body size limits (413) and strips prototype-pollution keys before schema validation', async () => {
    const app = createHttpApp({ logger: createNoopLogger(), maxBodyBytes: 128 });

    app.post(
      '/submit',
      validatedHandler(
        {
          body: z.object({ title: z.string() }),
          query: z.object({ mode: z.string().optional() }),
        },
        (ctx, { body, query }) => ctx.json({ title: body.title, mode: query.mode ?? 'default' }),
      ),
    );

    const client = createTestClient(app);

    const oversized = await client.post('/submit', {
      json: { title: 'x'.repeat(300) },
    });
    expect(oversized.status).toBe(413);

    const protoAttack = await client.post('/submit?__proto__=evil&mode=safe', {
      headers: { 'content-type': 'application/json' },
      body: '{"title":"clean","__proto__":{"polluted":true}}',
    });
    expect(protoAttack.status).toBe(200);
    expect(await protoAttack.json()).toEqual({ title: 'clean', mode: 'safe' });
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();

    await client.close();
  });
});
