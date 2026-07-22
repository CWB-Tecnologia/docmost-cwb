import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import SpaceAbilityFactory from '../casl/abilities/space-ability.factory';
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from '../casl/interfaces/space-ability.type';
import {
  BoardIdDto,
  CardIdDto,
  ColumnIdDto,
  CreateBoardDto,
  CreateCardDto,
  CreateColumnDto,
  MoveCardDto,
  MoveColumnDto,
  SpaceBoardDto,
  UpdateBoardDto,
  UpdateCardDto,
  UpdateColumnDto,
} from './dto/kanban.dto';
import { KanbanService } from './kanban.service';

@UseGuards(JwtAuthGuard)
@Controller('kanban')
export class KanbanController {
  constructor(
    private readonly kanbanService: KanbanService,
    private readonly spaceAbility: SpaceAbilityFactory,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post('boards/list')
  async listBoards(
    @Body() dto: SpaceBoardDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    await this.assertSpace(
      user,
      dto.spaceId,
      SpaceCaslAction.Read,
      SpaceCaslSubject.Page,
    );
    return this.kanbanService.list(dto.spaceId, workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('boards/create')
  async createBoard(
    @Body() dto: CreateBoardDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    await this.assertSpace(
      user,
      dto.spaceId,
      SpaceCaslAction.Manage,
      SpaceCaslSubject.Settings,
    );
    return this.kanbanService.createBoard(dto, user, workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('boards/info')
  async boardInfo(
    @Body() dto: BoardIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    await this.assertBoard(
      user,
      dto.boardId,
      workspace.id,
      SpaceCaslAction.Read,
      SpaceCaslSubject.Page,
    );
    return this.kanbanService.info(dto.boardId, workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('boards/update')
  async updateBoard(
    @Body() dto: UpdateBoardDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    await this.assertBoard(
      user,
      dto.boardId,
      workspace.id,
      SpaceCaslAction.Manage,
      SpaceCaslSubject.Settings,
    );
    return this.kanbanService.updateBoard(dto.boardId, dto.title, workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('boards/delete')
  async deleteBoard(
    @Body() dto: BoardIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    await this.assertBoard(
      user,
      dto.boardId,
      workspace.id,
      SpaceCaslAction.Manage,
      SpaceCaslSubject.Settings,
    );
    return this.kanbanService.deleteBoard(dto.boardId, workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('columns/create')
  async createColumn(
    @Body() dto: CreateColumnDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    await this.assertBoardAdmin(user, dto.boardId, workspace.id);
    return this.kanbanService.createColumn(dto, workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('columns/update')
  async updateColumn(
    @Body() dto: UpdateColumnDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    await this.assertBoardAdmin(user, dto.boardId, workspace.id);
    return this.kanbanService.updateColumn(dto, workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('columns/move')
  async moveColumn(
    @Body() dto: MoveColumnDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    await this.assertBoardAdmin(user, dto.boardId, workspace.id);
    return this.kanbanService.moveColumn(dto, workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('columns/delete')
  async deleteColumn(
    @Body() dto: ColumnIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    await this.assertBoardAdmin(user, dto.boardId, workspace.id);
    return this.kanbanService.deleteColumn(dto, workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('cards/create')
  async createCard(
    @Body() dto: CreateCardDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    await this.assertBoardWriter(user, dto.boardId, workspace.id);
    return this.kanbanService.createCard(dto, user, workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('cards/update')
  async updateCard(
    @Body() dto: UpdateCardDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    await this.assertBoardWriter(user, dto.boardId, workspace.id);
    return this.kanbanService.updateCard(dto, workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('cards/move')
  async moveCard(
    @Body() dto: MoveCardDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    await this.assertBoardWriter(user, dto.boardId, workspace.id);
    return this.kanbanService.moveCard(dto, workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('cards/delete')
  async deleteCard(
    @Body() dto: CardIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    await this.assertBoardWriter(user, dto.boardId, workspace.id);
    return this.kanbanService.deleteCard(dto, workspace.id);
  }

  private assertBoardAdmin(user: User, boardId: string, workspaceId: string) {
    return this.assertBoard(
      user,
      boardId,
      workspaceId,
      SpaceCaslAction.Manage,
      SpaceCaslSubject.Settings,
    );
  }

  private assertBoardWriter(user: User, boardId: string, workspaceId: string) {
    return this.assertBoard(
      user,
      boardId,
      workspaceId,
      SpaceCaslAction.Manage,
      SpaceCaslSubject.Page,
    );
  }

  private async assertBoard(
    user: User,
    boardId: string,
    workspaceId: string,
    action: SpaceCaslAction,
    subject: SpaceCaslSubject,
  ) {
    const board = await this.kanbanService.getBoard(boardId, workspaceId);
    return this.assertSpace(user, board.spaceId, action, subject);
  }

  private async assertSpace(
    user: User,
    spaceId: string,
    action: SpaceCaslAction,
    subject: SpaceCaslSubject,
  ) {
    const ability = await this.spaceAbility.createForUser(user, spaceId);
    if (ability.cannot(action, subject)) throw new ForbiddenException();
  }
}
