import { Injectable, Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QueueJob, QueueName } from '../queue/constants';
import { IAuditLogJob } from '../queue/constants/queue.interface';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { AuditRepo } from '@docmost/db/repos/audit/audit.repo';
import { randomUUID } from 'node:crypto';
import {
  AUDIT_CONTEXT_KEY,
  AuditContext,
} from '../../common/middlewares/audit-context.middleware';
import {
  ActorType,
  AuditLogPayload,
  EXCLUDED_AUDIT_EVENTS,
} from '../../common/events/audit-events';
import { AuditLogContext, IAuditService } from './audit.service';
import { redactAuditValue } from './audit-redaction.util';

/**
 * Real audit persister (AGPL). Reads per-request context from ClsService and
 * enqueues each event onto AUDIT_QUEUE; the processor appends it to the
 * workspace's hash chain. Enqueueing keeps request latency unaffected and lets
 * a single queue consumer serialize chain writes. Auditing must never break a
 * business flow, so every path here swallows its own errors.
 */
@Injectable()
export class DbAuditService implements IAuditService {
  private readonly logger = new Logger(DbAuditService.name);
  private readonly enabled: boolean;

  constructor(
    private readonly cls: ClsService,
    @InjectQueue(QueueName.AUDIT_QUEUE) private readonly auditQueue: Queue,
    private readonly workspaceRepo: WorkspaceRepo,
    private readonly auditRepo: AuditRepo,
  ) {
    this.enabled = process.env.AUDIT_ENABLED?.toLowerCase() !== 'false';
  }

  log(payload: AuditLogPayload): Promise<void> {
    return this.enqueue(payload, this.resolveContext());
  }

  logWithContext(
    payload: AuditLogPayload,
    context: AuditLogContext,
  ): Promise<void> {
    return this.enqueue(payload, context);
  }

  async logBatchWithContext(
    payloads: AuditLogPayload[],
    context: AuditLogContext,
  ): Promise<void> {
    await Promise.all(
      payloads.map((payload) => this.enqueue(payload, context)),
    );
  }

  setActorId(actorId: string): void {
    const context = this.cls.get<AuditContext>(AUDIT_CONTEXT_KEY);
    if (context) {
      context.actorId = actorId;
      this.cls.set(AUDIT_CONTEXT_KEY, context);
    }
  }

  setActorType(actorType: ActorType): void {
    const context = this.cls.get<AuditContext>(AUDIT_CONTEXT_KEY);
    if (context) {
      context.actorType = actorType;
      this.cls.set(AUDIT_CONTEXT_KEY, context);
    }
  }

  async updateRetention(
    workspaceId: string,
    retentionDays: number,
  ): Promise<void> {
    await this.workspaceRepo.updateWorkspace(
      { auditRetentionDays: retentionDays },
      workspaceId,
    );
  }

  private resolveContext(): AuditLogContext | null {
    const ctx = this.cls.get<AuditContext>(AUDIT_CONTEXT_KEY);
    if (!ctx || !ctx.workspaceId) return null;
    return {
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId ?? undefined,
      actorType: ctx.actorType,
      ipAddress: ctx.ipAddress ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    };
  }

  private async enqueue(
    payload: AuditLogPayload,
    context: AuditLogContext | null,
  ): Promise<void> {
    if (!this.enabled) return;
    if (EXCLUDED_AUDIT_EVENTS.has(payload.event)) return;
    if (!context?.workspaceId) {
      this.logger.warn(
        `Dropping audit event '${payload.event}': no workspace context`,
      );
      return;
    }

    const job: IAuditLogJob = {
      eventId: randomUUID(),
      workspaceId: context.workspaceId,
      actorId: context.actorId ?? null,
      actorType: context.actorType ?? 'user',
      event: payload.event,
      resourceType: payload.resourceType,
      resourceId: payload.resourceId ?? null,
      spaceId: payload.spaceId ?? null,
      changes: payload.changes ? redactAuditValue(payload.changes) : null,
      metadata: payload.metadata ? redactAuditValue(payload.metadata) : null,
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ?? null,
      createdAt: new Date().toISOString(),
    };

    try {
      await this.auditQueue.add(QueueJob.AUDIT_LOG, job, {
        jobId: job.eventId,
      });
      return;
    } catch (queueError) {
      this.logger.warn(
        `Audit queue unavailable for '${payload.event}', falling back to PostgreSQL: ${
          queueError instanceof Error ? queueError.message : String(queueError)
        }`,
      );
    }

    try {
      await this.auditRepo.appendChained({
        eventId: job.eventId,
        workspaceId: job.workspaceId,
        actorId: job.actorId,
        actorType: job.actorType,
        event: job.event,
        resourceType: job.resourceType,
        resourceId: job.resourceId,
        spaceId: job.spaceId,
        changes: job.changes,
        metadata: job.metadata,
        ipAddress: job.ipAddress,
        userAgent: job.userAgent,
        createdAt: new Date(job.createdAt),
      });
    } catch (err) {
      this.logger.error(
        `Failed to persist audit event '${payload.event}' through queue and fallback: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
