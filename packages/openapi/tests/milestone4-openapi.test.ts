import { createHttpApp } from '@forge-fr/http';
import {
  DEFAULT_SWAGGER_UI_DIST,
  generateOpenApiDocument,
  openApiMeta,
  registerOpenApiRoutes,
  renderSwaggerUiHtml,
  schemaToJsonSchema,
} from '@forge-fr/openapi';
import { createTestClient } from '@forge-fr/testing';
import { getValidated, validateRequest, validatedHandler } from '@forge-fr/validation';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

describe('@forge-fr/openapi — Unified Validation Auto-Discovery, Rich Reflection & Production Guards (Milestone 4)', () => {
  it('automatically discovers schemas from standard validatedHandler() and validateRequest() without validatedOpenApiHandler()', async () => {
    const app = createHttpApp();

    // 1. Standard validatedHandler() body-only fast path
    app.post(
      '/invoices',
      validatedHandler(
        {
          body: z.object({
            customerId: z.string().uuid().describe('Customer UUID'),
            amountCents: z.number().int().min(100),
          }),
        },
        (ctx, input) => ctx.json({ created: true, customerId: input.body.customerId }, 201),
      ),
      {
        meta: openApiMeta({
          operationId: 'createInvoice',
          summary: 'Create an invoice',
          tags: ['Invoices'],
        }),
      },
    );

    // 2. Standard validatedHandler() with params, query, headers, and response schema
    app.get(
      '/invoices/:invoiceId',
      validatedHandler(
        {
          params: z.object({ invoiceId: z.string().describe('Invoice identifier') }),
          query: z.object({ includeLineItems: z.boolean().default(false) }),
          headers: z.object({ 'x-tenant-id': z.string().min(2) }),
          response: z.object({
            invoiceId: z.string(),
            status: z.enum(['draft', 'paid']),
          }),
        },
        (_ctx, input) => ({
          invoiceId: input.params.invoiceId,
          status: 'paid' as const,
        }),
      ),
    );

    // 3. Route-level validateRequest() middleware
    app.patch(
      '/invoices/:invoiceId',
      (ctx) => {
        const input = getValidated<{
          params: { invoiceId: string };
          body: { status: 'draft' | 'paid' };
        }>(ctx);
        return ctx.json({ invoiceId: input.params.invoiceId, status: input.body.status });
      },
      {
        middleware: [
          validateRequest({
            params: v.object({ invoiceId: v.string() }),
            body: v.object({ status: v.picklist(['draft', 'paid']) }),
          }),
        ],
        meta: openApiMeta({
          summary: 'Patch invoice status',
        }),
      },
    );

    const doc = generateOpenApiDocument(app, {
      title: 'Billing API',
      version: '2.0.0',
    });

    const postOp = doc.paths['/invoices']?.post;
    expect(postOp?.operationId).toBe('createInvoice');
    expect(
      postOp?.requestBody?.content['application/json']?.schema?.properties?.['customerId'],
    ).toEqual({
      type: 'string',
      format: 'uuid',
      description: 'Customer UUID',
    });
    expect(
      postOp?.requestBody?.content['application/json']?.schema?.properties?.['amountCents'],
    ).toEqual({
      type: 'integer',
      minimum: 100,
    });

    const getOp = doc.paths['/invoices/{invoiceId}']?.get;
    const idParam = getOp?.parameters?.find((p) => p.name === 'invoiceId' && p.in === 'path');
    expect(idParam?.required).toBe(true);
    expect(idParam?.description).toBe('Invoice identifier');

    const queryParam = getOp?.parameters?.find(
      (p) => p.name === 'includeLineItems' && p.in === 'query',
    );
    expect(queryParam?.required).toBe(false);
    expect(queryParam?.schema.default).toBe(false);

    const headerParam = getOp?.parameters?.find(
      (p) => p.name === 'x-tenant-id' && p.in === 'header',
    );
    expect(headerParam?.required).toBe(true);
    expect(headerParam?.schema.minLength).toBe(2);

    expect(
      getOp?.responses['200']?.content?.['application/json']?.schema?.properties?.['status']?.enum,
    ).toEqual(['draft', 'paid']);

    const patchOp = doc.paths['/invoices/{invoiceId}']?.patch;
    expect(patchOp?.summary).toBe('Patch invoice status');
    expect(
      patchOp?.requestBody?.content['application/json']?.schema?.properties?.['status']?.enum,
    ).toEqual(['draft', 'paid']);
  });

  it('reflects advanced Zod (v4 + v3-compatible shapes) and Valibot v1 types (date, discriminatedUnion/variant, intersection, regex, array bounds, pipes)', () => {
    const zodComplex = z.object({
      createdAt: z.date().describe('Creation timestamp'),
      code: z.string().regex(/^[A-Z]{3}-\d{4}$/).length(8),
      score: z.number().gt(0).lt(100).multipleOf(0.5),
      items: z.array(z.string()).min(1).max(5),
      event: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('card'), last4: z.string() }),
        z.object({ kind: z.literal('bank'), iban: z.string() }),
      ]),
      merged: z.intersection(
        z.object({ a: z.string() }),
        z.object({ b: z.number() }),
      ),
      piped: z.string().min(2).transform((s) => s.trim()),
    });

    const reflectedZod = schemaToJsonSchema(zodComplex);
    expect(reflectedZod.properties?.['createdAt']).toEqual({
      type: 'string',
      format: 'date-time',
      description: 'Creation timestamp',
    });
    expect(reflectedZod.properties?.['code']).toEqual({
      type: 'string',
      pattern: '^[A-Z]{3}-\\d{4}$',
      minLength: 8,
      maxLength: 8,
    });
    expect(reflectedZod.properties?.['score']).toEqual({
      type: 'number',
      exclusiveMinimum: 0,
      exclusiveMaximum: 100,
      multipleOf: 0.5,
    });
    expect(reflectedZod.properties?.['items']).toEqual({
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      maxItems: 5,
    });
    expect(reflectedZod.properties?.['event']?.discriminator).toEqual({
      propertyName: 'kind',
    });
    expect(reflectedZod.properties?.['event']?.oneOf).toHaveLength(2);
    expect(reflectedZod.properties?.['merged']?.allOf).toHaveLength(2);
    expect(reflectedZod.properties?.['piped']).toEqual({
      type: 'string',
      minLength: 2,
    });

    // Valibot v1 piped constraints, variant, intersect, and date
    const valibotComplex = v.object({
      email: v.pipe(
        v.string(),
        v.email(),
        v.minLength(5),
        v.maxLength(120),
        v.description('Primary user email'),
      ),
      quantity: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(50)),
      tags: v.pipe(v.array(v.string()), v.minLength(1), v.maxLength(10)),
      publishedAt: v.date(),
      payment: v.variant('method', [
        v.object({ method: v.literal('pix'), key: v.string() }),
        v.object({ method: v.literal('wire'), account: v.string() }),
      ]),
      combined: v.intersect([
        v.object({ id: v.string() }),
        v.object({ active: v.boolean() }),
      ]),
    });

    const reflectedValibot = schemaToJsonSchema(valibotComplex);
    expect(reflectedValibot.properties?.['email']).toEqual({
      type: 'string',
      format: 'email',
      minLength: 5,
      maxLength: 120,
      description: 'Primary user email',
    });
    expect(reflectedValibot.properties?.['quantity']).toEqual({
      type: 'integer',
      minimum: 1,
      maximum: 50,
    });
    expect(reflectedValibot.properties?.['tags']).toEqual({
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      maxItems: 10,
    });
    expect(reflectedValibot.properties?.['publishedAt']).toEqual({
      type: 'string',
      format: 'date-time',
    });
    expect(reflectedValibot.properties?.['payment']?.discriminator).toEqual({
      propertyName: 'method',
    });
    expect(reflectedValibot.properties?.['payment']?.oneOf).toHaveLength(2);
    expect(reflectedValibot.properties?.['combined']?.allOf).toHaveLength(2);
  });

  it('supports multipart/form-data request bodies, binary response media types, and components.schemas', () => {
    const app = createHttpApp();

    app.post(
      '/documents/upload',
      validatedHandler(
        {
          body: z.object({
            title: z.string(),
            file: z.string().describe('Uploaded PDF file'),
          }),
        },
        (ctx) => ctx.json({ id: 'doc_1' }),
      ),
      {
        meta: openApiMeta({
          operationId: 'uploadDocument',
          requestBodyContentType: 'multipart/form-data',
          responses: {
            200: {
              description: 'Generated PDF receipt',
              contentType: 'application/pdf',
            },
          },
        }),
      },
    );

    const doc = generateOpenApiDocument(app, {
      title: 'Documents API',
      version: '1.0.0',
      schemas: {
        DocumentRecord: z.object({
          id: z.string(),
          title: z.string(),
        }),
      },
    });

    const uploadOp = doc.paths['/documents/upload']?.post;
    expect(
      uploadOp?.requestBody?.content['multipart/form-data']?.schema?.properties?.['title'],
    ).toEqual({ type: 'string' });
    expect(uploadOp?.responses['200']?.content?.['application/pdf']?.schema).toEqual({
      type: 'string',
      format: 'binary',
    });
    expect(doc.components?.schemas?.['DocumentRecord']?.properties?.['id']).toEqual({
      type: 'string',
    });
  });

  it('pins Swagger UI CDN, renders SRI integrity attributes, caches specs, and protects routes in production', async () => {
    expect(DEFAULT_SWAGGER_UI_DIST).toBe('https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.18.2');

    const htmlWithSri = renderSwaggerUiHtml('/openapi.json', {
      title: 'Hardened Docs',
      scriptIntegrity: 'sha384-scriptHash123',
      styleIntegrity: 'sha384-styleHash456',
    });
    expect(htmlWithSri).toContain(
      'href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.18.2/swagger-ui.css" integrity="sha384-styleHash456" crossorigin="anonymous"',
    );
    expect(htmlWithSri).toContain(
      'src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.18.2/swagger-ui-bundle.js" integrity="sha384-scriptHash123" crossorigin="anonymous"',
    );

    // 1. exposeInProduction: false skips registering /docs and /openapi.json in production
    const prodApp = createHttpApp();
    prodApp.get('/health', (ctx) => ctx.json({ ok: true }));
    registerOpenApiRoutes(prodApp, {
      title: 'Prod API',
      version: '1.0.0',
      exposeInProduction: false,
      environment: 'production',
    });
    const prodClient = createTestClient(prodApp);
    expect((await prodClient.get('/docs')).status).toBe(404);
    expect((await prodClient.get('/openapi.json')).status).toBe(404);

    // 2. authorize predicate guards /docs and /openapi.json with 403 Forbidden
    const guardedApp = createHttpApp();
    guardedApp.get(
      '/items',
      validatedHandler({ response: z.object({ count: z.number() }) }, () => ({ count: 0 })),
    );
    registerOpenApiRoutes(guardedApp, {
      title: 'Guarded API',
      version: '1.0.0',
      authorize: (ctx) => ctx.header('x-docs-token') === 'secret-docs-key',
    });

    const guardedClient = createTestClient(guardedApp);
    expect((await guardedClient.get('/docs')).status).toBe(403);
    expect((await guardedClient.get('/openapi.json')).status).toBe(403);

    const authorizedSpec = await guardedClient.get('/openapi.json', {
      headers: { 'x-docs-token': 'secret-docs-key' },
    });
    expect(authorizedSpec.status).toBe(200);
    const specBody = (await authorizedSpec.json()) as { paths: Record<string, unknown> };
    expect(specBody.paths['/items']).toBeDefined();

    // Dynamic route added after first cached spec generation invalidates the cache automatically
    guardedApp.post(
      '/items',
      validatedHandler({ body: z.object({ name: z.string() }) }, (ctx) => ctx.json({ ok: true })),
    );
    const refreshedSpec = await guardedClient.get('/openapi.json', {
      headers: { 'x-docs-token': 'secret-docs-key' },
    });
    const refreshedBody = (await refreshedSpec.json()) as {
      paths: Record<string, Record<string, unknown>>;
    };
    expect(refreshedBody.paths['/items']?.['post']).toBeDefined();
  });
});
