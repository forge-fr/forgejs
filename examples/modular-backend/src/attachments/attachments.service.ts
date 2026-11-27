import {
  createToken,
  ForbiddenError,
  NotFoundError,
} from '@forge-fr/core';
import type { AuthIdentity } from '@forge-fr/auth';
import { assertTenantIsolation } from '@forge-fr/authorization';
import { sanitizeFilename } from '@forge-fr/security';
import type { StorageAdapter } from '@forge-fr/storage';
import { toActor, type AuthService } from '../auth/auth.service.ts';
import type { PlaygroundStore } from '../store.ts';
import type { TaskAttachmentRecord } from '../types.ts';
import type { WebhooksService } from '../webhooks/webhooks.service.ts';

export interface UploadAttachmentInput {
  readonly taskId: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

export interface DownloadedAttachment {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly safeDispositionName: string;
}

export interface AttachmentsService {
  listForTask(identity: AuthIdentity, taskId: string): readonly TaskAttachmentRecord[];
  upload(identity: AuthIdentity, input: UploadAttachmentInput): Promise<TaskAttachmentRecord>;
  download(
    identity: AuthIdentity,
    taskId: string,
    attachmentId: string,
  ): Promise<DownloadedAttachment>;
  remove(identity: AuthIdentity, taskId: string, attachmentId: string): Promise<void>;
}

export const AttachmentsServiceToken = createToken<AttachmentsService>('playground:AttachmentsService');

export interface AttachmentsServiceDeps {
  readonly store: PlaygroundStore;
  readonly storage: StorageAdapter;
  readonly auth: AuthService;
  readonly webhooks: WebhooksService;
}

export function createAttachmentsService(deps: AttachmentsServiceDeps): AttachmentsService {
  const { store, storage, auth, webhooks } = deps;

  return {
    listForTask(identity: AuthIdentity, taskId: string): readonly TaskAttachmentRecord[] {
      const actor = toActor(identity);
      const task = store.tasks.get(taskId);
      if (!task) {
        throw new NotFoundError(`Task "${taskId}" not found`);
      }
      assertTenantIsolation(actor, task);
      return store.listAttachmentsForTask(task.tenantId, task.id);
    },

    async upload(identity: AuthIdentity, input: UploadAttachmentInput): Promise<TaskAttachmentRecord> {
      const actor = toActor(identity);
      auth.authorizer.assertPermission(actor, 'attachments:write');

      const task = store.tasks.get(input.taskId);
      if (!task) {
        throw new NotFoundError(`Task "${input.taskId}" not found`);
      }
      assertTenantIsolation(actor, task);

      const safeName = sanitizeFilename(input.filename || 'attachment.bin');
      const attachmentId = store.generateId('att');
      const storageKey = `${task.tenantId}/${task.id}/${attachmentId}-${safeName}`;

      // @forge-fr/storage enforces allowedMimeTypes + binary magic-byte verification
      const storedMeta = await storage.put(storageKey, input.bytes, {
        contentType: input.mimeType || 'application/octet-stream',
        metadata: {
          tenantId: task.tenantId,
          taskId: task.id,
          uploadedBy: identity.subject,
        },
      });

      const record: TaskAttachmentRecord = {
        id: attachmentId,
        tenantId: task.tenantId,
        taskId: task.id,
        storageKey: storedMeta.key,
        filename: safeName,
        mimeType: storedMeta.contentType,
        sizeBytes: storedMeta.size,
        etag: storedMeta.etag,
        uploadedBy: identity.subject,
        createdAt: new Date().toISOString(),
      };
      store.attachments.set(record.id, record);

      store.publishEvent({
        tenantId: task.tenantId,
        type: 'attachment.uploaded',
        actorName: auth.resolveActorName(identity),
        summary: `Uploaded "${safeName}" (${record.mimeType}) to ${task.id}`,
        data: { taskId: task.id, attachmentId: record.id, mimeType: record.mimeType },
      });

      await webhooks.enqueueMatching(task.tenantId, 'attachment.uploaded', {
        taskId: task.id,
        attachmentId: record.id,
        filename: safeName,
        mimeType: record.mimeType,
        sizeBytes: record.sizeBytes,
      });

      return record;
    },

    async download(
      identity: AuthIdentity,
      taskId: string,
      attachmentId: string,
    ): Promise<DownloadedAttachment> {
      const actor = toActor(identity);
      const attachment = store.attachments.get(attachmentId);
      if (!attachment || attachment.taskId !== taskId) {
        throw new NotFoundError('Attachment not found');
      }
      assertTenantIsolation(actor, attachment);

      const obj = await storage.get(attachment.storageKey);
      const bytes = await obj.bytes();
      const safeDispositionName = sanitizeFilename(attachment.filename).replace(/"/g, '');
      return {
        bytes: new Uint8Array(bytes),
        mimeType: attachment.mimeType,
        safeDispositionName,
      };
    },

    async remove(identity: AuthIdentity, taskId: string, attachmentId: string): Promise<void> {
      const actor = toActor(identity);
      const attachment = store.attachments.get(attachmentId);
      if (!attachment || attachment.taskId !== taskId) {
        throw new NotFoundError('Attachment not found');
      }
      assertTenantIsolation(actor, attachment);
      if (!actor.roles.includes('admin') && attachment.uploadedBy !== actor.subject) {
        throw new ForbiddenError('Access denied');
      }

      await storage.delete(attachment.storageKey);
      store.attachments.delete(attachment.id);

      store.publishEvent({
        tenantId: attachment.tenantId,
        type: 'attachment.deleted',
        actorName: auth.resolveActorName(identity),
        summary: `Deleted attachment "${attachment.filename}"`,
        data: { taskId: attachment.taskId, attachmentId: attachment.id },
      });
    },
  };
}
