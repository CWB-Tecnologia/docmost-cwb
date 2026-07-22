import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QueueJob, QueueName } from '../queue/constants';
import { IAuditCleanupJob } from '../queue/constants/queue.interface';

// LGPD-oriented default: keep audit history one year unless a workspace opts
// out (0 = keep forever) or sets its own window.
export const DEFAULT_AUDIT_RETENTION_DAYS = 365;

@Injectable()
export class AuditRetentionService {
  private readonly logger = new Logger(AuditRetentionService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    @InjectQueue(QueueName.AUDIT_QUEUE) private readonly auditQueue: Queue,
  ) {}

  @Interval('audit-cleanup', 24 * 60 * 60 * 1000) // every 24 hours
  async scheduleCleanup() {
    if (process.env.AUDIT_ENABLED?.toLowerCase() === 'false') return;
    try {
      const workspaces = await this.db
        .selectFrom('workspaces')
        .select(['id', 'auditRetentionDays'])
        .where('deletedAt', 'is', null)
        .execute();

      for (const workspace of workspaces) {
        const retentionDays =
          workspace.auditRetentionDays ?? DEFAULT_AUDIT_RETENTION_DAYS;

        // 0 (or negative) means retain indefinitely — skip the purge.
        if (!retentionDays || retentionDays <= 0) continue;

        const job: IAuditCleanupJob = {
          workspaceId: workspace.id,
          retentionDays,
        };

        await this.auditQueue.add(QueueJob.AUDIT_CLEANUP, job, {
          jobId: `audit-cleanup-${workspace.id}`,
        });
      }
    } catch (err) {
      this.logger.error(
        `Audit cleanup scheduling failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
