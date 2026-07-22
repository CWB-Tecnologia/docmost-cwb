import { DbAuditService } from './db-audit.service';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import { AUDIT_REDACTED_VALUE } from './audit-redaction.util';

describe('DbAuditService', () => {
  const context = {
    workspaceId: '01900000-0000-7000-8000-000000000001',
    actorId: '01900000-0000-7000-8000-000000000002',
    actorType: 'user' as const,
    ipAddress: '127.0.0.1',
    userAgent: 'jest',
  };
  const payload = {
    event: AuditEvent.USER_UPDATED,
    resourceType: AuditResource.USER,
    resourceId: '01900000-0000-7000-8000-000000000003',
    changes: { after: { role: 'admin', password: 'never-store-this' } },
  };

  let queue: { add: jest.Mock };
  let auditRepo: { appendChained: jest.Mock };
  let service: DbAuditService;

  beforeEach(() => {
    delete process.env.AUDIT_ENABLED;
    queue = { add: jest.fn().mockResolvedValue(undefined) };
    auditRepo = { appendChained: jest.fn().mockResolvedValue({}) };
    service = new DbAuditService(
      { get: jest.fn(), set: jest.fn() } as any,
      queue as any,
      { updateWorkspace: jest.fn() } as any,
      auditRepo as any,
    );
  });

  afterEach(() => {
    delete process.env.AUDIT_ENABLED;
  });

  it('queues a redacted, idempotent job with request context', async () => {
    await service.logWithContext(payload, context);

    expect(queue.add).toHaveBeenCalledTimes(1);
    const [, job, options] = queue.add.mock.calls[0];
    expect(job).toMatchObject({
      workspaceId: context.workspaceId,
      actorId: context.actorId,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      changes: {
        after: { role: 'admin', password: AUDIT_REDACTED_VALUE },
      },
    });
    expect(job.eventId).toEqual(expect.any(String));
    expect(options).toEqual({ jobId: job.eventId });
    expect(auditRepo.appendChained).not.toHaveBeenCalled();
  });

  it('falls back to PostgreSQL with the same event id when Redis fails', async () => {
    queue.add.mockRejectedValueOnce(new Error('redis unavailable'));

    await service.logWithContext(payload, context);

    const queuedJob = queue.add.mock.calls[0][1];
    expect(auditRepo.appendChained).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: queuedJob.eventId,
        workspaceId: context.workspaceId,
        userAgent: context.userAgent,
      }),
    );
  });

  it('does not persist excluded high-volume events', async () => {
    await service.logWithContext(
      {
        event: AuditEvent.PAGE_CREATED,
        resourceType: AuditResource.PAGE,
      },
      context,
    );

    expect(queue.add).not.toHaveBeenCalled();
    expect(auditRepo.appendChained).not.toHaveBeenCalled();
  });
});
