import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { jsonObjectFrom } from 'kysely/helpers/postgres';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { executeTx } from '@docmost/db/utils';
import { Audit } from '@docmost/db/types/entity.types';
import { executeWithCursorPagination } from '@docmost/db/pagination/cursor-pagination';
import { ActorType } from '../../../common/events/audit-events';
import {
  computeAuditHash,
  computeCheckpointHash,
  GENESIS_PREV_HASH,
} from '../../../integrations/audit/audit-hash.util';

export interface AppendAuditInput {
  eventId: string;
  workspaceId: string;
  actorId?: string | null;
  actorType: ActorType;
  event: string;
  resourceType: string;
  resourceId?: string | null;
  spaceId?: string | null;
  changes?: Record<string, any> | null;
  metadata?: Record<string, any> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  createdAt: Date;
}

export interface AuditListParams {
  event?: string;
  actorId?: string;
  resourceType?: string;
  spaceId?: string;
  startDate?: Date;
  endDate?: Date;
  limit: number;
  cursor?: string;
}

export type VerifyBrokenReason =
  | 'hash_mismatch'
  | 'prev_link_mismatch'
  | 'seq_gap'
  | 'checkpoint_hash_mismatch'
  | 'checkpoint_link_mismatch'
  | 'checkpoint_seq_regression'
  | 'checkpoint_row_count_mismatch';

export interface VerifyChainResult {
  ok: boolean;
  checked: number;
  checkedCheckpoints: number;
  fromSeq: number | null;
  toSeq: number | null;
  firstBrokenSeq?: number;
  firstBrokenCheckpointSeq?: number;
  reason?: VerifyBrokenReason;
}

const toIso = (value: unknown): string =>
  value instanceof Date
    ? value.toISOString()
    : new Date(value as any).toISOString();

@Injectable()
export class AuditRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  /**
   * Append a row to the workspace's tamper-evident chain. Serialized per
   * workspace with a transaction-scoped advisory lock so seq stays contiguous
   * and each row's prev_hash points at the true predecessor, even across
   * multiple app instances processing the audit queue concurrently.
   */
  async appendChained(input: AppendAuditInput): Promise<Audit> {
    return executeTx(this.db, async (trx) => {
      await sql`select pg_advisory_xact_lock(hashtext(${
        'audit:' + input.workspaceId
      }))`.execute(trx);

      const existing = await trx
        .selectFrom('audit')
        .selectAll()
        .where('id', '=', input.eventId)
        .where('workspaceId', '=', input.workspaceId)
        .executeTakeFirst();
      if (existing) return existing as Audit;

      const tail = await trx
        .selectFrom('audit')
        .select(['seq', 'hash'])
        .where('workspaceId', '=', input.workspaceId)
        .orderBy('seq', 'desc')
        .limit(1)
        .executeTakeFirst();

      let baseSeq = tail ? Number(tail.seq) : 0;
      let prevHash = tail ? tail.hash : GENESIS_PREV_HASH;

      if (!tail) {
        // The chain's head may have been purged; resume from the last checkpoint.
        const checkpoint = await trx
          .selectFrom('auditCheckpoint')
          .select(['upToSeq', 'upToHash'])
          .where('workspaceId', '=', input.workspaceId)
          .orderBy('upToSeq', 'desc')
          .limit(1)
          .executeTakeFirst();
        if (checkpoint) {
          baseSeq = Number(checkpoint.upToSeq);
          prevHash = checkpoint.upToHash;
        }
      }

      const seq = baseSeq + 1;
      const createdAt = input.createdAt;
      const hash = computeAuditHash({
        workspaceId: input.workspaceId,
        seq,
        prevHash,
        actorId: input.actorId ?? null,
        actorType: input.actorType,
        event: input.event,
        resourceType: input.resourceType,
        resourceId: input.resourceId ?? null,
        spaceId: input.spaceId ?? null,
        changes: input.changes ?? null,
        metadata: input.metadata ?? null,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
        createdAt: createdAt.toISOString(),
      });

      const inserted = await trx
        .insertInto('audit')
        .values({
          id: input.eventId,
          workspaceId: input.workspaceId,
          actorId: input.actorId ?? null,
          actorType: input.actorType,
          event: input.event,
          resourceType: input.resourceType,
          resourceId: input.resourceId ?? null,
          spaceId: input.spaceId ?? null,
          changes:
            input.changes != null
              ? sql`${JSON.stringify(input.changes)}::text::jsonb`
              : null,
          metadata:
            input.metadata != null
              ? sql`${JSON.stringify(input.metadata)}::text::jsonb`
              : null,
          ipAddress: input.ipAddress ?? null,
          userAgent: input.userAgent ?? null,
          createdAt,
          seq,
          prevHash,
          hash,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      return inserted as unknown as Audit;
    });
  }

  async list(workspaceId: string, params: AuditListParams) {
    let query = this.db
      .selectFrom('audit')
      .select((eb) => [
        'audit.id',
        'audit.workspaceId',
        'audit.actorId',
        'audit.actorType',
        'audit.event',
        'audit.resourceType',
        'audit.resourceId',
        'audit.spaceId',
        'audit.changes',
        'audit.metadata',
        'audit.ipAddress',
        'audit.userAgent',
        'audit.seq',
        'audit.prevHash',
        'audit.hash',
        'audit.createdAt',
        jsonObjectFrom(
          eb
            .selectFrom('users')
            .select([
              'users.id',
              'users.name',
              'users.email',
              'users.avatarUrl',
            ])
            .whereRef('users.id', '=', 'audit.actorId'),
        ).as('actor'),
      ])
      .where('audit.workspaceId', '=', workspaceId);

    if (params.event) query = query.where('audit.event', '=', params.event);
    if (params.actorId)
      query = query.where('audit.actorId', '=', params.actorId);
    if (params.resourceType)
      query = query.where('audit.resourceType', '=', params.resourceType);
    if (params.spaceId)
      query = query.where('audit.spaceId', '=', params.spaceId);
    if (params.startDate)
      query = query.where('audit.createdAt', '>=', params.startDate);
    if (params.endDate)
      query = query.where('audit.createdAt', '<=', params.endDate);

    return executeWithCursorPagination(query, {
      perPage: params.limit,
      cursor: params.cursor,
      fields: [{ expression: 'audit.seq', direction: 'desc', key: 'seq' }],
      parseCursor: (c) => ({ seq: Number(c.seq) }),
    });
  }

  /** Rows for export, applying the same filters as list (capped by maxRows). */
  async findForExport(
    workspaceId: string,
    params: Omit<AuditListParams, 'limit' | 'cursor'>,
    maxRows = 100_000,
  ) {
    let query = this.db
      .selectFrom('audit')
      .leftJoin('users', 'users.id', 'audit.actorId')
      .select([
        'audit.id',
        'audit.workspaceId',
        'audit.seq',
        'audit.prevHash',
        'audit.hash',
        'audit.createdAt',
        'audit.event',
        'audit.resourceType',
        'audit.resourceId',
        'audit.spaceId',
        'audit.actorId',
        'users.name as actorName',
        'users.email as actorEmail',
        'audit.actorType',
        'audit.ipAddress',
        'audit.userAgent',
        'audit.changes',
        'audit.metadata',
      ])
      .where('audit.workspaceId', '=', workspaceId)
      .orderBy('audit.seq', 'asc');

    if (params.event) query = query.where('audit.event', '=', params.event);
    if (params.actorId)
      query = query.where('audit.actorId', '=', params.actorId);
    if (params.resourceType)
      query = query.where('audit.resourceType', '=', params.resourceType);
    if (params.spaceId)
      query = query.where('audit.spaceId', '=', params.spaceId);
    if (params.startDate)
      query = query.where('audit.createdAt', '>=', params.startDate);
    if (params.endDate)
      query = query.where('audit.createdAt', '<=', params.endDate);

    return query.limit(maxRows).execute();
  }

  async listCheckpoints(workspaceId: string) {
    return this.db
      .selectFrom('auditCheckpoint')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .orderBy('upToSeq', 'asc')
      .execute();
  }

  /**
   * Recompute the chain and report the first broken link. Full verification
   * (no range) anchors at genesis or the earliest relevant checkpoint and
   * detects any content tamper, prev-link break, or sequence gap.
   */
  async verifyChain(
    workspaceId: string,
    opts?: { fromSeq?: number; toSeq?: number },
  ): Promise<VerifyChainResult> {
    const checkpoints = await this.db
      .selectFrom('auditCheckpoint')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .orderBy('upToSeq', 'asc')
      .execute();

    let checkedCheckpoints = 0;
    let previousCheckpointHash = GENESIS_PREV_HASH;
    let previousCheckpointSeq = 0;

    for (const current of checkpoints) {
      const upToSeq = Number(current.upToSeq);
      if (upToSeq <= previousCheckpointSeq) {
        return {
          ok: false,
          checked: 0,
          checkedCheckpoints,
          fromSeq: null,
          toSeq: null,
          firstBrokenCheckpointSeq: upToSeq,
          reason: 'checkpoint_seq_regression',
        };
      }
      if (Number(current.rowCount) !== upToSeq - previousCheckpointSeq) {
        return {
          ok: false,
          checked: 0,
          checkedCheckpoints,
          fromSeq: null,
          toSeq: null,
          firstBrokenCheckpointSeq: upToSeq,
          reason: 'checkpoint_row_count_mismatch',
        };
      }
      if (current.prevCheckpointHash !== previousCheckpointHash) {
        return {
          ok: false,
          checked: 0,
          checkedCheckpoints,
          fromSeq: null,
          toSeq: null,
          firstBrokenCheckpointSeq: upToSeq,
          reason: 'checkpoint_link_mismatch',
        };
      }

      const recomputed = computeCheckpointHash({
        workspaceId,
        upToSeq,
        upToHash: current.upToHash,
        rowCount: Number(current.rowCount),
        prevCheckpointHash: current.prevCheckpointHash,
        sealedAt: toIso(current.sealedAt),
      });
      if (recomputed !== current.checkpointHash) {
        return {
          ok: false,
          checked: 0,
          checkedCheckpoints,
          fromSeq: null,
          toSeq: null,
          firstBrokenCheckpointSeq: upToSeq,
          reason: 'checkpoint_hash_mismatch',
        };
      }

      previousCheckpointHash = current.checkpointHash;
      previousCheckpointSeq = upToSeq;
      checkedCheckpoints++;
    }

    const checkpoint = opts?.fromSeq
      ? [...checkpoints]
          .reverse()
          .find((candidate) => Number(candidate.upToSeq) < opts.fromSeq!)
      : checkpoints[checkpoints.length - 1];

    let expectedSeq = checkpoint
      ? Number(checkpoint.upToSeq) + 1
      : (opts?.fromSeq ?? 1);
    let prevHash = checkpoint ? checkpoint.upToHash : GENESIS_PREV_HASH;

    let query = this.db
      .selectFrom('audit')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .orderBy('seq', 'asc');
    if (opts?.fromSeq) {
      // A cryptographic range cannot jump directly from a checkpoint to an
      // arbitrary later row. Walk every surviving link after the checkpoint
      // up to the requested window; without a checkpoint, the first requested
      // row is the best available local anchor.
      const verificationStartSeq = checkpoint
        ? Number(checkpoint.upToSeq) + 1
        : opts.fromSeq;
      query = query.where('seq', '>=', verificationStartSeq);
    }
    if (opts?.toSeq) query = query.where('seq', '<=', opts.toSeq);

    const rows = await query.execute();

    let checked = 0;
    let firstSeq: number | null = null;
    let lastSeq: number | null = null;
    let first = true;

    for (const row of rows) {
      const seq = Number(row.seq);
      if (first) {
        firstSeq = seq;
        // Partial range with no covering checkpoint: trust this row's prev_hash
        // as the anchor (links before the window cannot be verified here).
        if (opts?.fromSeq && opts.fromSeq > 1 && !checkpoint) {
          prevHash = row.prevHash;
        }
        first = false;
      }

      if (seq !== expectedSeq) {
        return {
          ok: false,
          checked,
          checkedCheckpoints,
          fromSeq: firstSeq,
          toSeq: lastSeq,
          firstBrokenSeq: expectedSeq,
          reason: 'seq_gap',
        };
      }
      if (row.prevHash !== prevHash) {
        return {
          ok: false,
          checked,
          checkedCheckpoints,
          fromSeq: firstSeq,
          toSeq: lastSeq,
          firstBrokenSeq: seq,
          reason: 'prev_link_mismatch',
        };
      }

      const recomputed = computeAuditHash({
        workspaceId,
        seq,
        prevHash,
        actorId: row.actorId,
        actorType: row.actorType,
        event: row.event,
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        spaceId: row.spaceId,
        changes: row.changes,
        metadata: row.metadata,
        ipAddress: row.ipAddress,
        userAgent: row.userAgent,
        createdAt: toIso(row.createdAt),
      });
      if (recomputed !== row.hash) {
        return {
          ok: false,
          checked,
          checkedCheckpoints,
          fromSeq: firstSeq,
          toSeq: lastSeq,
          firstBrokenSeq: seq,
          reason: 'hash_mismatch',
        };
      }

      prevHash = row.hash;
      expectedSeq = seq + 1;
      lastSeq = seq;
      checked++;
    }

    return {
      ok: true,
      checked,
      checkedCheckpoints,
      fromSeq: firstSeq,
      toSeq: lastSeq,
    };
  }

  /**
   * Seal and delete everything older than `cutoff`. The tail hash of the
   * deleted window is recorded in audit_checkpoint first, so the chain stays
   * verifiable from the checkpoint and the purge itself is provable.
   */
  async purgeOlderThan(
    workspaceId: string,
    cutoff: Date,
  ): Promise<{ deleted: number; upToSeq: number | null }> {
    return executeTx(this.db, async (trx) => {
      await sql`select pg_advisory_xact_lock(hashtext(${
        'audit:' + workspaceId
      }))`.execute(trx);

      const boundary = await trx
        .selectFrom('audit')
        .select(['seq', 'hash'])
        .where('workspaceId', '=', workspaceId)
        .where('createdAt', '<', cutoff)
        .orderBy('seq', 'desc')
        .limit(1)
        .executeTakeFirst();

      if (!boundary) return { deleted: 0, upToSeq: null };

      const upToSeq = Number(boundary.seq);
      const upToHash = boundary.hash;

      const countRow = await trx
        .selectFrom('audit')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('workspaceId', '=', workspaceId)
        .where('seq', '<=', upToSeq)
        .executeTakeFirst();
      const rowCount = Number(countRow?.count ?? 0);

      const previousCheckpoint = await trx
        .selectFrom('auditCheckpoint')
        .select(['upToSeq', 'checkpointHash'])
        .where('workspaceId', '=', workspaceId)
        .orderBy('upToSeq', 'desc')
        .limit(1)
        .executeTakeFirst();

      if (previousCheckpoint && upToSeq <= Number(previousCheckpoint.upToSeq)) {
        return { deleted: 0, upToSeq: null };
      }

      const sealedAt = new Date();
      const prevCheckpointHash =
        previousCheckpoint?.checkpointHash ?? GENESIS_PREV_HASH;
      const checkpointHash = computeCheckpointHash({
        workspaceId,
        upToSeq,
        upToHash,
        rowCount,
        prevCheckpointHash,
        sealedAt: sealedAt.toISOString(),
      });

      await trx
        .insertInto('auditCheckpoint')
        .values({
          workspaceId,
          upToSeq,
          upToHash,
          rowCount,
          prevCheckpointHash,
          checkpointHash,
          sealedAt,
        })
        .execute();

      const res = await trx
        .deleteFrom('audit')
        .where('workspaceId', '=', workspaceId)
        .where('seq', '<=', upToSeq)
        .executeTakeFirst();

      return { deleted: Number(res?.numDeletedRows ?? 0), upToSeq };
    });
  }
}
