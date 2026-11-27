import { createHttpApp } from '@forge-fr/http';
import {
  OpenApiTokens,
  createOpenApiPlugin,
  generateOpenApiDocument,
  openApiMeta,
  registerOpenApiRoutes,
  renderSwaggerUiHtml,
  schemaToJsonSchema,
  validatedOpenApiHandler,
} from '@forge-fr/openapi';
import { createPluginTestHarness, createTestClient } from '@forge-fr/testing';
import { customSchema } from '@forge-fr/validation';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

describe('@forge-fr/openapi — OpenAPI 3.1 Generation, Schema Reflection & Swagger UI', () => {
  it('reflects Zod v4, Valibot v1, and custom schemas to clean JSON Schema 2020-12 objects', () => {
    const zodUser = z.object({
      id: z.string(),
      age: z.number().int().optional(),
      role: z.enum(['admin', 'member']),
      tags: z.array(z.string()),
    });

    const zodJson = schemaToJsonSchema(zodUser);
    expect(zodJson['type']).toBe('object');
    expect(zodJson['required']).toEqual(['id', 'role', 'tags']);
    expect(zodJson['properties']?.['age']?.['type']).toBe('integer');
    expect(zodJson['properties']?.['role']?.['enum']).toEqual(['admin', 'member']);

    const valibotItem = v.object({
      title: v.string(),
      count: v.optional(v.number()),
      status: v.picklist(['draft', 'published']),
    });
    const valibotJson = schemaToJsonSchema(valibotItem);
    expect(valibotJson['type']).toBe('object');
    expect(valibotJson['required']).toEqual(['title', 'status']);
    expect(valibotJson['properties']?.['status']?.['enum']).toEqual(['draft', 'published']);

    const custom = Object.assign(
      customSchema((input) => ({ value: String(input) })),
      {
        jsonSchema: { type: 'string', format: 'uuid' } as const,
      },
    );
    expect(schemaToJsonSchema(custom)).toEqual({ type: 'string', format: 'uuid' });
  });

  it('generates OpenAPI 3.1.0 documents directly from app routes and validatedOpenApiHandler metadata', async () => {
    const app = createHttpApp();

    const paramsSchema = z.object({ id: z.string() });
    const querySchema = v.object({ includeMeta: v.optional(v.boolean()) });
    const bodySchema = z.object({ name: z.string(), role: z.enum(['owner', 'editor']) });
    const responseSchema = z.object({ id: z.string(), name: z.string(), role: z.string() });

    app.post(
      '/projects/:id{\\d+}',
      validatedOpenApiHandler(
        {
          params: paramsSchema,
          query: querySchema,
          body: bodySchema,
          response: responseSchema,
        },
        (_ctx, input) => ({
          id: input.params.id,
          name: input.body.name,
          role: input.body.role,
        }),
        {
          operationId: 'updateProject',
          summary: 'Update project metadata',
          tags: ['Projects'],
          security: [{ bearerAuth: [] }],
        },
      ),
    );

    app.get(
      '/health/live',
      (ctx) => ctx.json({ ok: true }),
      {
        meta: openApiMeta({
          exclude: true,
        }),
      },
    );

    const doc = generateOpenApiDocument(app, {
      title: 'ForgeJS API',
      version: '1.0.0',
      servers: [{ url: 'https://api.example.com' }],
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
    });

    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title).toBe('ForgeJS API');
    expect(doc.paths['/health/live']).toBeUndefined();

    const op = doc.paths['/projects/{id}']?.post;
    expect(op?.operationId).toBe('updateProject');
    expect(op?.summary).toBe('Update project metadata');
    expect(op?.tags).toEqual(['Projects']);
    expect(op?.parameters?.find((p) => p.name === 'id' && p.in === 'path')?.required).toBe(true);
    expect(op?.parameters?.find((p) => p.name === 'includeMeta' && p.in === 'query')?.required).toBe(
      false,
    );
    expect(op?.requestBody?.required).toBe(true);
    expect(op?.requestBody?.content['application/json']?.schema?.['properties']?.['name']).toEqual({
      type: 'string',
    });
    expect(
      op?.responses['200']?.content?.['application/json']?.schema?.['properties']?.['role'],
    ).toEqual({ type: 'string' });
    expect(doc.components?.securitySchemes?.['bearerAuth']?.scheme).toBe('bearer');
  });

  it('mounts escaped Swagger UI + /openapi.json with strict CSP headers and integrates ForgeJS DI plugin', async () => {
    const app = createHttpApp();
    app.get(
      '/ping',
      validatedOpenApiHandler(
        { response: z.object({ pong: z.boolean() }) },
        () => ({ pong: true }),
        { summary: 'Ping endpoint' },
      ),
    );

    registerOpenApiRoutes(app, {
      title: 'Evil </script><script>alert(1)</script> Title',
      version: '0.1.0',
      specPath: '/openapi.json',
      docsPath: '/docs',
    });

    const client = createTestClient(app);

    const specRes = await client.get('/openapi.json');
    expect(specRes.status).toBe(200);
    const specJson = (await specRes.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(specJson.openapi).toBe('3.1.0');
    expect(specJson.paths['/ping']).toBeDefined();
    expect(specJson.paths['/docs']).toBeUndefined();
    expect(specJson.paths['/openapi.json']).toBeUndefined();

    const docsRes = await client.get('/docs');
    expect(docsRes.status).toBe(200);
    expect(docsRes.headers.get('content-security-policy')).toContain("object-src 'none'");
    expect(docsRes.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const html = await docsRes.text();
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).toContain('&lt;/script&gt;');

    const safeHtml = renderSwaggerUiHtml('/openapi.json', { title: 'Clean Docs' });
    expect(safeHtml).toContain('SwaggerUIBundle');

    const pluginApp = createHttpApp();
    const harness = createPluginTestHarness({
      plugin: createOpenApiPlugin({
        app: pluginApp,
        title: 'Plugin Docs',
        version: '0.1.0',
      }),
    });
    await harness.start();
    const doc = harness.resolveExport(OpenApiTokens.Document);
    expect(doc.info.title).toBe('Plugin Docs');
    const health = await harness.health();
    expect(health.status).toBe('ok');
    expect(health.checks['openapi']?.status).toBe('ok');
    await harness.shutdown();
  });
});
