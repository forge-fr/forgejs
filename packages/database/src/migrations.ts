import { ConflictError, ForgeError } from '@forge-fr/core';

export interface Migration<TClient = unknown> {
  readonly id: string;
  readonly name: string;
  readonly checksum: string;
  readonly up: (client: TClient) => Promise<void>;
  readonly down?: (client: TClient) => Promise<void>;
}

export interface MigrationRecord {
  readonly id: string;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: string;
}

export interface MigrationStateStore {
  listApplied(): Promise<readonly MigrationRecord[]>;
  markApplied(record: MigrationRecord): Promise<void>;
  markRolledBack(id: string): Promise<void>;
}

export interface MigrationHooks<TClient = unknown> {
  readonly beforeMigrate?: (migration: Migration<TClient>) => void | Promise<void>;
  readonly afterMigrate?: (migration: Migration<TClient>) => void | Promise<void>;
  readonly beforeRollback?: (migration: Migration<TClient>) => void | Promise<void>;
  readonly afterRollback?: (migration: Migration<TClient>) => void | Promise<void>;
}

export interface MigrationRunResult {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}

export interface MigrationCoordinatorOptions<TClient = unknown> {
  readonly store: MigrationStateStore;
  readonly migrations: readonly Migration<TClient>[];
  readonly hooks?: MigrationHooks<TClient>;
}

export interface MigrationCoordinator<TClient = unknown> {
  migrate(client: TClient): Promise<MigrationRunResult>;
  rollbackLast(client: TClient): Promise<string | null>;
  listMigrations(): readonly Migration<TClient>[];
}

export class MigrationChecksumError extends ForgeError {
  public readonly migrationId: string;
  public readonly expectedChecksum: string;
  public readonly actualChecksum: string;

  public constructor(migrationId: string, expectedChecksum: string, actualChecksum: string) {
    super(
      `Migration "${migrationId}" checksum mismatch: recorded "${expectedChecksum}", current "${actualChecksum}"`,
      {
        code: 'DB_MIGRATION_CHECKSUM_MISMATCH',
        statusCode: 500,
        expose: false,
        details: { migrationId },
      },
    );
    this.migrationId = migrationId;
    this.expectedChecksum = expectedChecksum;
    this.actualChecksum = actualChecksum;
  }
}

export class MigrationRollbackError extends ForgeError {
  public constructor(message: string, details?: Record<string, unknown>) {
    super(message, {
      code: 'DB_MIGRATION_ROLLBACK_ERROR',
      statusCode: 500,
      expose: false,
      ...(details !== undefined ? { details } : {}),
    });
  }
}

export function createMigrationCoordinator<TClient = unknown>(
  options: MigrationCoordinatorOptions<TClient>,
): MigrationCoordinator<TClient> {
  const seenIds = new Set<string>();
  const sorted = [...options.migrations].sort((a, b) => a.id.localeCompare(b.id));

  for (const m of sorted) {
    if (m.id.trim().length === 0) {
      throw new ConflictError('Migration id must be a non-empty string');
    }
    if (seenIds.has(m.id)) {
      throw new ConflictError(`Duplicate migration id "${m.id}"`, {
        details: { migrationId: m.id },
      });
    }
    seenIds.add(m.id);
  }

  const byId = new Map<string, Migration<TClient>>(sorted.map((m) => [m.id, m]));

  return {
    listMigrations(): readonly Migration<TClient>[] {
      return Object.freeze([...sorted]);
    },

    async migrate(client: TClient): Promise<MigrationRunResult> {
      const appliedRecords = await options.store.listApplied();
      const appliedMap = new Map<string, MigrationRecord>(
        appliedRecords.map((rec) => [rec.id, rec]),
      );

      const applied: string[] = [];
      const skipped: string[] = [];

      for (const migration of sorted) {
        const existing = appliedMap.get(migration.id);
        if (existing !== undefined) {
          if (existing.checksum !== migration.checksum) {
            throw new MigrationChecksumError(migration.id, existing.checksum, migration.checksum);
          }
          skipped.push(migration.id);
          continue;
        }

        await options.hooks?.beforeMigrate?.(migration);
        await migration.up(client);
        await options.store.markApplied({
          id: migration.id,
          name: migration.name,
          checksum: migration.checksum,
          appliedAt: new Date().toISOString(),
        });
        await options.hooks?.afterMigrate?.(migration);
        applied.push(migration.id);
      }

      return Object.freeze({
        applied: Object.freeze(applied),
        skipped: Object.freeze(skipped),
      });
    },

    async rollbackLast(client: TClient): Promise<string | null> {
      const appliedRecords = await options.store.listApplied();
      if (appliedRecords.length === 0) {
        return null;
      }

      const lastRecord = appliedRecords[appliedRecords.length - 1]!;
      const migration = byId.get(lastRecord.id);
      if (!migration) {
        throw new MigrationRollbackError(
          `Cannot rollback migration "${lastRecord.id}" because its definition is not registered`,
          { migrationId: lastRecord.id },
        );
      }
      if (migration.down === undefined) {
        throw new MigrationRollbackError(
          `Migration "${migration.id}" does not define a down() rollback handler`,
          { migrationId: migration.id },
        );
      }

      await options.hooks?.beforeRollback?.(migration);
      await migration.down(client);
      await options.store.markRolledBack(migration.id);
      await options.hooks?.afterRollback?.(migration);
      return migration.id;
    },
  };
}
