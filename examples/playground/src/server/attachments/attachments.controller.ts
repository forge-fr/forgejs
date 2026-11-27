import { ValidationError } from '@forge-fr/core';
import { requireAuth } from '@forge-fr/auth';
import type { ForgeHttpApp } from '@forge-fr/http';
import { validatedOpenApiHandler } from '@forge-fr/openapi';
import { z } from 'zod';
import { requireBearerAuth } from '../auth/auth.middleware.ts';
import { AttachmentsServiceToken } from './attachments.service.ts';

const IdParamSchema = z.object({
  id: z.string().min(1).max(80),
});

const AttachmentParamSchema = z.object({
  id: z.string().min(1).max(80),
  attachmentId: z.string().min(1).max(80),
});

export function registerAttachmentsController(app: ForgeHttpApp): void {
  app.group(
    '/playground-api/tasks/:id/attachments',
    (group) => {
      group.get(
        '/',
        validatedOpenApiHandler(
          { params: IdParamSchema },
          (ctx, { params }) => {
            const identity = requireAuth(ctx);
            const service = ctx.resolve(AttachmentsServiceToken);
            return ctx.json({ attachments: service.listForTask(identity, params.id) });
          },
          {
            summary: 'List attachments stored in @forge-fr/storage for a tenant task',
            tags: ['Attachments'],
          },
        ),
      );

      group.post(
        '/',
        validatedOpenApiHandler(
          { params: IdParamSchema },
          async (ctx, { params }) => {
            const identity = requireAuth(ctx);
            const service = ctx.resolve(AttachmentsServiceToken);

            const multipart = await ctx.body.multipart({
              maxFiles: 1,
              maxFileBytes: 512 * 1024,
            });
            const uploaded = multipart.files[0];
            if (!uploaded) {
              throw new ValidationError('Multipart upload requires a file field named "file"');
            }

            const record = await service.upload(identity, {
              taskId: params.id,
              filename: uploaded.name || 'attachment.bin',
              mimeType: uploaded.type || 'application/octet-stream',
              bytes: new Uint8Array(await uploaded.arrayBuffer()),
            });

            return ctx.json({ attachment: record }, { status: 201 });
          },
          {
            summary: 'Upload a task attachment with @forge-fr/storage MIME & binary magic-byte validation',
            tags: ['Attachments'],
          },
        ),
      );

      group.get(
        '/:attachmentId/download',
        validatedOpenApiHandler(
          { params: AttachmentParamSchema },
          async (ctx, { params }) => {
            const identity = requireAuth(ctx);
            const service = ctx.resolve(AttachmentsServiceToken);
            const downloaded = await service.download(identity, params.id, params.attachmentId);

            return new Response(new Uint8Array(downloaded.bytes), {
              status: 200,
              headers: {
                'content-type': downloaded.mimeType,
                'content-disposition': `attachment; filename="${downloaded.safeDispositionName}"`,
                'x-content-type-options': 'nosniff',
                'cache-control': 'private, no-store',
              },
            });
          },
          {
            summary: 'Download a stored task attachment from @forge-fr/storage',
            tags: ['Attachments'],
          },
        ),
      );

      group.delete(
        '/:attachmentId',
        validatedOpenApiHandler(
          { params: AttachmentParamSchema },
          async (ctx, { params }) => {
            const identity = requireAuth(ctx);
            const service = ctx.resolve(AttachmentsServiceToken);
            await service.remove(identity, params.id, params.attachmentId);
            return ctx.json({ deleted: true, attachmentId: params.attachmentId });
          },
          {
            summary: 'Delete an attachment from @forge-fr/storage',
            tags: ['Attachments'],
          },
        ),
      );
    },
    { middleware: [requireBearerAuth] },
  );
}
