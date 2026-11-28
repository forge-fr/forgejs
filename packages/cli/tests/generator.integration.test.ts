import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  inflectSymbolName,
  pluralizeWord,
  runCli,
  singularizeWord,
} from '@forge-fr/cli';
import type { ForgeModule } from '@forge-fr/core';
import { createHttpApp, type ForgeHttpApp } from '@forge-fr/http';
import { generateOpenApiDocument } from '@forge-fr/openapi';
import { createTestClient } from '@forge-fr/testing';
import { afterEach, describe, expect, it } from 'vitest';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('@forge-fr/cli — Modular Code Generator Integration Suite (Milestone 5 / Part 4)', () => {
  it('inflects singular and plural symbol names accurately across regular, irregular, and uncountable nouns', () => {
    expect(singularizeWord('products')).toBe('product');
    expect(singularizeWord('product')).toBe('product');
    expect(singularizeWord('categories')).toBe('category');
    expect(singularizeWord('people')).toBe('person');
    expect(singularizeWord('addresses')).toBe('address');
    expect(singularizeWord('health')).toBe('health');

    expect(pluralizeWord('product')).toBe('products');
    expect(pluralizeWord('products')).toBe('products');
    expect(pluralizeWord('category')).toBe('categories');
    expect(pluralizeWord('person')).toBe('people');
    expect(pluralizeWord('address')).toBe('addresses');
    expect(pluralizeWord('health')).toBe('health');

    const inflected = inflectSymbolName('order_item');
    expect(inflected).toEqual({
      kebab: 'order-item',
      pascal: 'OrderItem',
      camel: 'orderItem',
      singularKebab: 'order-item',
      singularPascal: 'OrderItem',
      singularCamel: 'orderItem',
      pluralKebab: 'order-items',
      pluralPascal: 'OrderItems',
      pluralCamel: 'orderItems',
    });
  });

  it('generates the complete 5-file modular structure (`forge g module products`) and executes real CRUD + DI + OpenAPI requests', async () => {
    const projectDir = await makeTempDir('forge-gen-products-');

    const genRes = await runCli(['g', 'module', 'products'], { cwd: projectDir });
    expect(genRes.exitCode).toBe(0);

    const expectedFiles = [
      'src/modules/products/products.schema.ts',
      'src/modules/products/products.repository.ts',
      'src/modules/products/products.service.ts',
      'src/modules/products/products.controller.ts',
      'src/modules/products/products.module.ts',
    ];
    expect((genRes.data as { files: string[] }).files).toEqual(expectedFiles);

    for (const rel of expectedFiles) {
      const stat = await fs.stat(path.join(projectDir, rel));
      expect(stat.isFile()).toBe(true);
    }

    // Dynamic import of the generated TypeScript module files (executed under Vitest/Vite transform)
    const modulePath = path.join(projectDir, 'src/modules/products/products.module.ts');
    const controllerPath = path.join(projectDir, 'src/modules/products/products.controller.ts');

    const importedModule = (await import(pathToFileURL(modulePath).href)) as {
      productsModule: ForgeModule;
    };
    const importedController = (await import(pathToFileURL(controllerPath).href)) as {
      registerProductsController: (app: ForgeHttpApp) => void;
    };

    const app = createHttpApp();
    app.registerModule(importedModule.productsModule);
    importedController.registerProductsController(app);
    await app.start();

    const client = createTestClient(app);

    // 1. Create product (POST /products)
    const createRes = await client.post('/products', {
      json: { name: 'Mechanical Keyboard', description: 'Hot-swappable 75%' },
    });
    expect(createRes.status).toBe(201);
    const createdPayload = (await createRes.json()) as {
      data: { id: string; name: string; description: string };
    };
    expect(createdPayload.data.id).toBe('product_1');
    expect(createdPayload.data.name).toBe('Mechanical Keyboard');

    // 2. Validation error on invalid payload (POST /products)
    const invalidRes = await client.post('/products', {
      json: { name: '' },
    });
    expect(invalidRes.status).toBe(400);

    // 3. List products (GET /products)
    const listRes = await client.get('/products');
    expect(listRes.status).toBe(200);
    const listPayload = (await listRes.json()) as { data: Array<{ id: string }> };
    expect(listPayload.data).toHaveLength(1);

    // 4. Get by ID (GET /products/:id)
    const getRes = await client.get('/products/product_1');
    expect(getRes.status).toBe(200);

    // 5. Update product (PATCH /products/:id)
    const patchRes = await client.patch('/products/product_1', {
      json: { name: 'Pro Mechanical Keyboard' },
    });
    expect(patchRes.status).toBe(200);
    const patchedPayload = (await patchRes.json()) as { data: { name: string } };
    expect(patchedPayload.data.name).toBe('Pro Mechanical Keyboard');

    // 6. Delete product (DELETE /products/:id)
    const delRes = await client.delete('/products/product_1');
    expect(delRes.status).toBe(204);

    // 7. Missing product returns 404 NotFoundError
    const missingRes = await client.get('/products/product_1');
    expect(missingRes.status).toBe(404);

    // 8. Milestone 4 OpenAPI auto-discovery works seamlessly on generated controller routes!
    const openApiDoc = generateOpenApiDocument(app, {
      title: 'Generated Products API',
      version: '1.0.0',
    });
    expect(openApiDoc.paths['/products']?.post?.requestBody).toBeDefined();
    expect(openApiDoc.paths['/products/{id}']?.patch?.requestBody).toBeDefined();

    await client.close();
  });

  it('supports individual generators (`schema`, `repository`, `service`, `controller`, `resource`), conflict detection, dry-run, interactive mode, custom config, and `--register`', async () => {
    const projectDir = await makeTempDir('forge-gen-individual-');

    // Configure custom modulesDir via forge.config.json
    await fs.writeFile(
      path.join(projectDir, 'forge.config.json'),
      JSON.stringify({ modulesDir: 'src/domain', naming: 'plural' }, null, 2),
      'utf8',
    );
    await fs.mkdir(path.join(projectDir, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(projectDir, 'src/app.ts'),
      [
        `import { createHttpApp, type ForgeHttpApp } from '@forge-fr/http';`,
        ``,
        `export function createApp(): ForgeHttpApp {`,
        `  const app = createHttpApp();`,
        `  return app;`,
        `}`,
        ``,
      ].join('\n'),
      'utf8',
    );

    // Individual generators for "user" (inflected to "users" in src/domain/users/)
    expect((await runCli(['g', 'schema', 'user'], { cwd: projectDir })).exitCode).toBe(0);
    expect((await runCli(['g', 'repository', 'user'], { cwd: projectDir })).exitCode).toBe(0);
    expect((await runCli(['g', 'service', 'user'], { cwd: projectDir })).exitCode).toBe(0);
    expect((await runCli(['g', 'controller', 'user'], { cwd: projectDir })).exitCode).toBe(0);
    expect(
      (await runCli(['g', 'module', 'user', '--single'], { cwd: projectDir })).exitCode,
    ).toBe(0);

    // Conflict detection: re-running without --force fails with CLI_FILE_EXISTS and never overwrites
    const conflictRes = await runCli(['g', 'service', 'user'], { cwd: projectDir });
    expect(conflictRes.exitCode).toBe(1);
    expect(conflictRes.stderr).toContain('CLI_FILE_EXISTS');

    // Dry-run mode plans files without writing
    const dryRes = await runCli(
      ['g', 'resource', 'invoice', '--out-dir', 'src/features', '--dry-run'],
      { cwd: projectDir },
    );
    expect(dryRes.exitCode).toBe(0);
    expect(dryRes.stdout).toContain('[dry-run] Would generate src/features/invoices/invoices.module.ts');
    await expect(
      fs.stat(path.join(projectDir, 'src/features/invoices/invoices.module.ts')),
    ).rejects.toThrow();

    // Interactive mode with custom prompt callback + --register into src/app.ts
    const answers = ['resource', 'category'];
    const interactiveRes = await runCli(['g', '--interactive', '--register'], {
      cwd: projectDir,
      prompt: async (_question, defaultVal) => answers.shift() ?? defaultVal ?? '',
    });
    expect(interactiveRes.exitCode).toBe(0);
    expect((interactiveRes.data as { files: string[] }).files).toContain(
      'src/domain/categories/categories.module.ts',
    );

    const updatedAppTs = await fs.readFile(path.join(projectDir, 'src/app.ts'), 'utf8');
    expect(updatedAppTs).toContain(
      `import { categoriesModule } from './domain/categories/categories.module.js';`,
    );
    expect(updatedAppTs).toContain(
      `import { registerCategoriesController } from './domain/categories/categories.controller.js';`,
    );
    expect(updatedAppTs).toContain('app.registerModule(categoriesModule);');
    expect(updatedAppTs).toContain('registerCategoriesController(app);');
  });
});
