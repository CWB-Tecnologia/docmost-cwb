import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { stringify } from 'csv-stringify/sync';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import WorkspaceAbilityFactory from '../../core/casl/abilities/workspace-ability.factory';
import {
  WorkspaceCaslAction,
  WorkspaceCaslSubject,
} from '../../core/casl/interfaces/workspace-ability.type';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { AuditListParams, AuditRepo } from '@docmost/db/repos/audit/audit.repo';
import { AUDIT_SERVICE, IAuditService } from './audit.service';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import { DEFAULT_AUDIT_RETENTION_DAYS } from './audit-retention.service';
import {
  AuditExportDto,
  AuditListDto,
  AuditRetentionUpdateDto,
  AuditVerifyDto,
} from './dto/audit.dto';

@UseGuards(JwtAuthGuard)
@Controller('audit')
export class AuditController {
  constructor(
    private readonly auditRepo: AuditRepo,
    private readonly workspaceRepo: WorkspaceRepo,
    private readonly workspaceAbility: WorkspaceAbilityFactory,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post()
  async list(
    @Body() dto: AuditListDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertOwner(user, workspace);
    return this.auditRepo.list(workspace.id, {
      ...this.toFilters(dto),
      limit: dto.limit ?? 50,
      cursor: dto.cursor,
    });
  }

  @HttpCode(HttpStatus.OK)
  @Post('retention')
  async getRetention(
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertOwner(user, workspace);
    const ws = await this.workspaceRepo.findById(workspace.id);
    return {
      retentionDays: ws?.auditRetentionDays ?? DEFAULT_AUDIT_RETENTION_DAYS,
    };
  }

  @HttpCode(HttpStatus.OK)
  @Post('retention/update')
  async updateRetention(
    @Body() dto: AuditRetentionUpdateDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertOwner(user, workspace);
    const currentWorkspace = await this.workspaceRepo.findById(workspace.id);
    await this.auditService.updateRetention(
      workspace.id,
      dto.auditRetentionDays,
    );
    // Changing the retention policy is itself auditable.
    await this.auditService.log({
      event: AuditEvent.AUDIT_RETENTION_UPDATED,
      resourceType: AuditResource.AUDIT,
      resourceId: workspace.id,
      changes: {
        before: {
          auditRetentionDays:
            currentWorkspace?.auditRetentionDays ??
            DEFAULT_AUDIT_RETENTION_DAYS,
        },
        after: { auditRetentionDays: dto.auditRetentionDays },
      },
    });
    return { retentionDays: dto.auditRetentionDays };
  }

  @HttpCode(HttpStatus.OK)
  @Post('verify')
  async verify(
    @Body() dto: AuditVerifyDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertOwner(user, workspace);
    if (dto.fromSeq && dto.toSeq && dto.fromSeq > dto.toSeq) {
      throw new BadRequestException(
        'fromSeq must be less than or equal to toSeq',
      );
    }
    const result = await this.auditRepo.verifyChain(workspace.id, {
      fromSeq: dto.fromSeq,
      toSeq: dto.toSeq,
    });
    await this.auditService.log({
      event: AuditEvent.AUDIT_INTEGRITY_VERIFIED,
      resourceType: AuditResource.AUDIT,
      resourceId: workspace.id,
      metadata: {
        ok: result.ok,
        checked: result.checked,
        checkedCheckpoints: result.checkedCheckpoints,
        reason: result.reason,
      },
    });
    return result;
  }

  @HttpCode(HttpStatus.OK)
  @Post('export')
  async export(
    @Body() dto: AuditExportDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
    @Res() res: FastifyReply,
  ) {
    this.assertOwner(user, workspace);

    const filters = this.toFilters(dto);
    const [rows, checkpoints] = await Promise.all([
      this.auditRepo.findForExport(workspace.id, filters),
      this.auditRepo.listCheckpoints(workspace.id),
    ]);
    const format = dto.format ?? 'csv';
    const stamp = new Date().toISOString().slice(0, 10);
    const base = `audit-${workspace.id}-${stamp}`;
    const exportedAt = new Date().toISOString();

    const entries = rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspaceId,
      seq: Number(r.seq),
      prevHash: r.prevHash,
      hash: r.hash,
      createdAt:
        r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
      event: r.event,
      resourceType: r.resourceType,
      resourceId: r.resourceId,
      spaceId: r.spaceId,
      actorId: r.actorId,
      actorType: r.actorType,
      actor: r.actorId
        ? {
            id: r.actorId,
            name: r.actorName,
            email: r.actorEmail,
          }
        : null,
      ipAddress: r.ipAddress,
      userAgent: r.userAgent,
      changes: r.changes,
      metadata: r.metadata,
    }));

    const serializedCheckpoints = checkpoints.map((checkpoint) => ({
      id: checkpoint.id,
      workspaceId: checkpoint.workspaceId,
      upToSeq: Number(checkpoint.upToSeq),
      upToHash: checkpoint.upToHash,
      rowCount: Number(checkpoint.rowCount),
      prevCheckpointHash: checkpoint.prevCheckpointHash,
      checkpointHash: checkpoint.checkpointHash,
      sealedAt:
        checkpoint.sealedAt instanceof Date
          ? checkpoint.sealedAt.toISOString()
          : checkpoint.sealedAt,
    }));

    // Exporting the audit log is itself an audited, owner-only action (LGPD).
    await this.auditService.log({
      event: AuditEvent.AUDIT_EXPORTED,
      resourceType: AuditResource.AUDIT,
      resourceId: workspace.id,
      metadata: {
        format,
        count: entries.length,
        checkpointCount: serializedCheckpoints.length,
        filters,
      },
    });

    if (format === 'json') {
      res.headers({
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${base}.json"`,
      });
      res.send(
        JSON.stringify(
          {
            formatVersion: 1,
            workspaceId: workspace.id,
            exportedAt,
            filters,
            checkpoints: serializedCheckpoints,
            entries,
          },
          null,
          2,
        ),
      );
      return;
    }

    const filtersJson = this.csvSafe(JSON.stringify(filters));
    const checkpointRecords = serializedCheckpoints.map((checkpoint) => ({
      formatVersion: 1,
      recordType: 'checkpoint',
      workspaceId: workspace.id,
      exportedAt,
      filters: filtersJson,
      checkpointId: checkpoint.id,
      checkpointUpToSeq: checkpoint.upToSeq,
      checkpointUpToHash: checkpoint.upToHash,
      checkpointRowCount: checkpoint.rowCount,
      prevCheckpointHash: checkpoint.prevCheckpointHash,
      checkpointHash: checkpoint.checkpointHash,
      checkpointSealedAt: checkpoint.sealedAt,
    }));
    const auditRecords = entries.map((entry) => ({
      formatVersion: 1,
      recordType: 'audit',
      workspaceId: workspace.id,
      exportedAt,
      filters: filtersJson,
      eventId: entry.id,
      seq: entry.seq,
      prevHash: entry.prevHash,
      hash: entry.hash,
      createdAt: entry.createdAt,
      event: entry.event,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId ?? '',
      spaceId: entry.spaceId ?? '',
      actorId: entry.actorId ?? '',
      actorName: this.csvSafe(entry.actor?.name ?? ''),
      actorEmail: this.csvSafe(entry.actor?.email ?? ''),
      actorType: entry.actorType,
      ipAddress: entry.ipAddress ?? '',
      userAgent: this.csvSafe(entry.userAgent ?? ''),
      changes: entry.changes ? this.csvSafe(JSON.stringify(entry.changes)) : '',
      metadata: entry.metadata
        ? this.csvSafe(JSON.stringify(entry.metadata))
        : '',
    }));

    const csv = stringify([...checkpointRecords, ...auditRecords], {
      header: true,
      columns: [
        'formatVersion',
        'recordType',
        'workspaceId',
        'exportedAt',
        'filters',
        'eventId',
        'seq',
        'prevHash',
        'hash',
        'createdAt',
        'event',
        'resourceType',
        'resourceId',
        'spaceId',
        'actorId',
        'actorName',
        'actorEmail',
        'actorType',
        'ipAddress',
        'userAgent',
        'changes',
        'metadata',
        'checkpointId',
        'checkpointUpToSeq',
        'checkpointUpToHash',
        'checkpointRowCount',
        'prevCheckpointHash',
        'checkpointHash',
        'checkpointSealedAt',
      ],
    });
    res.headers({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${base}.csv"`,
    });
    res.send(csv);
  }

  private assertOwner(user: User, workspace: Workspace) {
    const ability = this.workspaceAbility.createForUser(user, workspace);
    if (
      ability.cannot(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Audit)
    ) {
      throw new ForbiddenException(
        'Only workspace owners can access audit logs',
      );
    }
  }

  private toFilters(
    dto: AuditListDto,
  ): Omit<AuditListParams, 'limit' | 'cursor'> {
    return {
      event: dto.event,
      actorId: dto.actorId,
      resourceType: dto.resourceType,
      spaceId: dto.spaceId,
      startDate: dto.startDate ? new Date(dto.startDate) : undefined,
      endDate: dto.endDate ? new Date(dto.endDate) : undefined,
    };
  }

  // Guard against CSV formula injection in spreadsheet apps.
  private csvSafe(value: string): string {
    return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  }
}
