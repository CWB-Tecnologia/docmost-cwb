import { Logger, OnModuleDestroy } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QueueJob, QueueName } from '../queue/constants';
import {
  IAuditCleanupJob,
  IAuditLogJob,
} from '../queue/constants/queue.interface';
import { AuditRepo } from '@docmost/db/repos/audit/audit.repo';
import { ActorType } from '../../common/events/audit-events';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import { randomUUID } from 'node:crypto';

/**
 * Single consumer for AUDIT_QUEUE. Default WorkerHost concurrency (1) plus the
 * per-workspace advisory lock in AuditRepo keeps chain appends serialized even
 * across multiple app instances.
 */
@Processor(QueueName.AUDIT_QUEUE)
export class AuditQueueProcessor extends WorkerHost implements OnModuleDestroy {
  private readonly logger = new Logger(AuditQueueProcessor.name);

  constructor(private readonly auditRepo: AuditRepo) {
    super();
  }

  async process(job: Job): Promise<void> {
    switch (job.name) {
      case QueueJob.AUDIT_LOG: {
        const data = job.data as IAuditLogJob;
        await this.auditRepo.appendChained({
          eventId: data.eventId,
          workspaceId: data.workspaceId,
          actorId: data.actorId ?? null,
          actorType: (data.actorType as ActorType) ?? 'user',
          event: data.event,
          resourceType: data.resourceType,
          resourceId: data.resourceId ?? null,
          spaceId: data.spaceId ?? null,
          changes: data.changes ?? null,
          metadata: data.metadata ?? null,
          ipAddress: data.ipAddress ?? null,
          userAgent: data.userAgent ?? null,
          createdAt: new Date(data.createdAt),
        });
        break;
      }

      case QueueJob.AUDIT_CLEANUP: {
        const data = job.data as IAuditCleanupJob;
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - data.retentionDays);
        const result = await this.auditRepo.purgeOlderThan(
          data.workspaceId,
          cutoff,
        );
        if (result.deleted > 0) {
          await this.auditRepo.appendChained({
            eventId: randomUUID(),
            workspaceId: data.workspaceId,
            actorId: null,
            actorType: 'system',
            event: AuditEvent.AUDIT_PURGED,
            resourceType: AuditResource.AUDIT,
            resourceId: null,
            changes: null,
            metadata: {
              deleted: result.deleted,
              upToSeq: result.upToSeq,
              retentionDays: data.retentionDays,
            },
            ipAddress: null,
            userAgent: null,
            createdAt: new Date(),
          });
          this.logger.debug(
            `Purged ${result.deleted} audit rows for workspace ${data.workspaceId} up to seq ${result.upToSeq}`,
          );
        }
        break;
      }
    }
  }

  @OnWorkerEvent('failed')
  onError(job: Job) {
    this.logger.error(
      `Error processing ${job.name} audit job. Reason: ${job.failedReason}`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
    }
  }
}
