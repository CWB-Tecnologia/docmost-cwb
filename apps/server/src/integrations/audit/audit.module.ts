import { Global, Module } from '@nestjs/common';
import { AUDIT_SERVICE, NoopAuditService } from './audit.service';
import { DbAuditService } from './db-audit.service';
import { AuditQueueProcessor } from './audit-queue.processor';
import { AuditRetentionService } from './audit-retention.service';
import { AuditController } from './audit.controller';

/**
 * Real, AGPL audit module. Binds AUDIT_SERVICE to the persisting DbAuditService,
 * runs the queue consumer + retention scheduler, and exposes the owner-only
 * audit API. DbAuditService self-disables writes when AUDIT_ENABLED=false, so a
 * misconfiguration can never take down logins by throwing from an audit call.
 * NoopAuditService is retained for reference / manual fallback.
 */
@Global()
@Module({
  controllers: [AuditController],
  providers: [
    NoopAuditService,
    AuditQueueProcessor,
    AuditRetentionService,
    {
      provide: AUDIT_SERVICE,
      useClass: DbAuditService,
    },
  ],
  exports: [AUDIT_SERVICE],
})
export class AuditModule {}
