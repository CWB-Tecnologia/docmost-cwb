import {
  BadRequestException,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import SpaceAbilityFactory from '../../core/casl/abilities/space-ability.factory';
import WorkspaceAbilityFactory from '../../core/casl/abilities/workspace-ability.factory';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from '../../core/casl/interfaces/space-ability.type';
import {
  WorkspaceCaslAction,
  WorkspaceCaslSubject,
} from '../../core/casl/interfaces/workspace-ability.type';
import { SpaceService } from '../../core/space/services/space.service';
import { FileInterceptor } from '../../common/interceptors/file.interceptor';
import * as bytes from 'bytes';
import * as path from 'path';
import { ImportService } from './services/import.service';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { EnvironmentService } from '../environment/environment.service';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../integrations/audit/audit.service';

@Controller()
export class ImportController {
  private readonly logger = new Logger(ImportController.name);

  constructor(
    private readonly importService: ImportService,
    private readonly spaceService: SpaceService,
    private readonly spaceAbility: SpaceAbilityFactory,
    private readonly workspaceAbility: WorkspaceAbilityFactory,
    private readonly environmentService: EnvironmentService,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  @UseInterceptors(FileInterceptor)
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('pages/import')
  async importPage(
    @Req() req: any,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const validFileExtensions = ['.md', '.html', '.docx', '.pdf'];

    const maxFileSize = bytes('30mb');

    let file = null;
    try {
      file = await req.file({
        limits: { fileSize: maxFileSize, fields: 4, files: 1 },
      });
    } catch (err: any) {
      this.logger.error(err.message);
      if (err?.statusCode === 413) {
        throw new BadRequestException(
          `File too large. Exceeds the 10mb import limit`,
        );
      }
    }

    if (!file) {
      throw new BadRequestException('Failed to upload file');
    }

    if (
      !validFileExtensions.includes(path.extname(file.filename).toLowerCase())
    ) {
      throw new BadRequestException('Invalid import file type.');
    }

    const spaceId = file.fields?.spaceId?.value;

    if (!spaceId) {
      throw new BadRequestException('spaceId is required');
    }

    const ability = await this.spaceAbility.createForUser(user, spaceId);
    if (ability.cannot(SpaceCaslAction.Edit, SpaceCaslSubject.Page)) {
      throw new ForbiddenException();
    }

    const createdPage = await this.importService.importPage(
      file,
      user.id,
      spaceId,
      workspace.id,
    );

    const ext = path.extname(file.filename).toLowerCase();
    const sourceMap: Record<string, string> = {
      '.md': 'markdown',
      '.html': 'html',
      '.docx': 'docx',
      '.pdf': 'pdf',
    };

    if (createdPage) {
      this.auditService.log({
        event: AuditEvent.PAGE_CREATED,
        resourceType: AuditResource.PAGE,
        resourceId: createdPage.id,
        spaceId,
        metadata: {
          source: sourceMap[ext],
          fileName: file.filename,
        },
      });
    }

    return createdPage;
  }

  @UseInterceptors(FileInterceptor)
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('pages/import-zip')
  async importZip(
    @Req() req: any,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const validFileExtensions = ['.zip'];

    const maxFileSize = bytes(this.environmentService.getFileImportSizeLimit());

    let file = null;
    try {
      file = await req.file({
        limits: { fileSize: maxFileSize, fields: 3, files: 1 },
      });
    } catch (err: any) {
      this.logger.error(err.message);
      if (err?.statusCode === 413) {
        throw new BadRequestException(
          `File too large. Exceeds the ${this.environmentService.getFileImportSizeLimit()} import limit`,
        );
      }
    }

    if (!file) {
      throw new BadRequestException('Failed to upload file');
    }

    if (
      !validFileExtensions.includes(path.extname(file.filename).toLowerCase())
    ) {
      throw new BadRequestException('Invalid import file extension.');
    }

    const spaceId = file.fields?.spaceId?.value;
    const source = file.fields?.source?.value;

    const validZipSources = ['generic', 'notion', 'confluence'];
    if (!validZipSources.includes(source)) {
      throw new BadRequestException(
        'Invalid import source. Import source must either be generic, notion or confluence.',
      );
    }

    if (!spaceId) {
      throw new BadRequestException('spaceId is required');
    }

    const ability = await this.spaceAbility.createForUser(user, spaceId);
    if (ability.cannot(SpaceCaslAction.Edit, SpaceCaslSubject.Page)) {
      throw new ForbiddenException();
    }

    this.auditService.log({
      event: AuditEvent.PAGE_IMPORTED,
      resourceType: AuditResource.PAGE,
      resourceId: spaceId,
      spaceId,
      metadata: {
        fileName: file.filename,
        source,
        spaceId,
      },
    });

    return this.importService.importZip(
      file,
      source,
      user.id,
      spaceId,
      workspace.id,
    );
  }

  /**
   * Creates a space and imports a zip into it in a single call.
   *
   * `pages/import-zip` can only fill a space that already exists, so migrating a
   * whole instance meant creating every space by hand first. Here the space is
   * created from the fields that precede the file in the multipart body, and is
   * deleted again if the upload fails, so a rejected zip never leaves an empty
   * space behind.
   */
  @UseInterceptors(FileInterceptor)
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('spaces/import-zip')
  async importSpaceZip(
    @Req() req: any,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const ability = this.workspaceAbility.createForUser(user, workspace);
    if (ability.cannot(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Space)) {
      throw new ForbiddenException();
    }

    const maxFileSize = bytes(this.environmentService.getFileImportSizeLimit());

    let file = null;
    try {
      file = await req.file({
        limits: { fileSize: maxFileSize, fields: 5, files: 1 },
      });
    } catch (err: any) {
      this.logger.error(err.message);
      if (err?.statusCode === 413) {
        throw new BadRequestException(
          `File too large. Exceeds the ${this.environmentService.getFileImportSizeLimit()} import limit`,
        );
      }
    }

    if (!file) {
      throw new BadRequestException('Failed to upload file');
    }

    if (path.extname(file.filename).toLowerCase() !== '.zip') {
      throw new BadRequestException('Invalid import file extension.');
    }

    const source = file.fields?.source?.value ?? 'generic';
    const validZipSources = ['generic', 'notion', 'confluence'];
    if (!validZipSources.includes(source)) {
      throw new BadRequestException(
        'Invalid import source. Import source must either be generic, notion or confluence.',
      );
    }

    const name = (file.fields?.name?.value ?? '').trim();
    if (name.length < 2 || name.length > 100) {
      throw new BadRequestException(
        'Space name is required and must be between 2 and 100 characters',
      );
    }

    const slug = (file.fields?.slug?.value ?? '').trim();
    if (
      slug.length < 2 ||
      slug.length > 100 ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(slug)
    ) {
      throw new BadRequestException(
        'Space slug must start with a letter or number and may contain hyphens and underscores',
      );
    }

    const description = (file.fields?.description?.value ?? '').trim();
    if (description.length > 500) {
      throw new BadRequestException(
        'Space description must be at most 500 characters',
      );
    }

    const space = await this.spaceService.createSpace(user, workspace.id, {
      name,
      slug,
      description,
    });

    let fileTask = null;
    try {
      fileTask = await this.importService.importZip(
        file,
        source,
        user.id,
        space.id,
        workspace.id,
      );
    } catch (err: any) {
      // The space is only worth keeping if the zip actually made it into the
      // import queue. Otherwise the operator is left with an empty space and no
      // way to tell it apart from a real one.
      this.logger.error(
        `Failed to queue zip import for new space ${space.id}, deleting it: ${err?.message}`,
      );
      await this.spaceService.deleteSpace(space.id, workspace.id);
      throw err;
    }

    this.auditService.log({
      event: AuditEvent.PAGE_IMPORTED,
      resourceType: AuditResource.PAGE,
      resourceId: space.id,
      spaceId: space.id,
      metadata: {
        fileName: file.filename,
        source,
        spaceId: space.id,
        spaceCreated: true,
      },
    });

    return { space, fileTask };
  }
}
