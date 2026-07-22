import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { generateNJitteredKeysBetween } from 'fractional-indexing-jittered';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { executeTx } from '@docmost/db/utils';
import { KanbanRepo } from '@docmost/db/repos/kanban/kanban.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { User } from '@docmost/db/types/entity.types';
import { WsService } from '../../ws/ws.service';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../integrations/audit/audit.service';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import {
  CreateBoardDto,
  CreateCardDto,
  CreateColumnDto,
  MoveCardDto,
  MoveColumnDto,
  UpdateCardDto,
  UpdateColumnDto,
} from './dto/kanban.dto';

const MAX_COLUMNS = 20;
const MAX_CARDS = 500;

@Injectable()
export class KanbanService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly kanbanRepo: KanbanRepo,
    private readonly spaceMemberRepo: SpaceMemberRepo,
    private readonly userRepo: UserRepo,
    private readonly wsService: WsService,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  list(spaceId: string, workspaceId: string) {
    return this.kanbanRepo.listBoards(spaceId, workspaceId);
  }

  async getBoard(boardId: string, workspaceId: string) {
    const board = await this.kanbanRepo.findBoard(boardId, workspaceId);
    if (!board) throw new NotFoundException('Board not found');
    return board;
  }

  async info(boardId: string, workspaceId: string) {
    const board = await this.getBoard(boardId, workspaceId);
    const [columns, cards] = await Promise.all([
      this.kanbanRepo.listColumns(board.id),
      this.kanbanRepo.listCards(board.id),
    ]);
    return { ...board, columns, cards };
  }

  async createBoard(dto: CreateBoardDto, user: User, workspaceId: string) {
    const board = await executeTx(this.db, async (trx) => {
      const created = await this.kanbanRepo.insertBoard(
        {
          title: dto.title.trim(),
          spaceId: dto.spaceId,
          workspaceId,
          creatorId: user.id,
        },
        trx,
      );
      const positions = generateNJitteredKeysBetween(null, null, 3);
      for (const [index, name] of ['To do', 'In progress', 'Done'].entries()) {
        await this.kanbanRepo.insertColumn(
          {
            boardId: created.id,
            name,
            color: null,
            position: positions[index],
          },
          trx,
        );
      }
      return created;
    });
    this.auditService.log({
      event: AuditEvent.KANBAN_BOARD_CREATED,
      resourceType: AuditResource.KANBAN_BOARD,
      resourceId: board.id,
      spaceId: board.spaceId,
      changes: { after: { title: board.title } },
    });
    this.emit(board.spaceId, board.id);
    return board;
  }

  async updateBoard(boardId: string, title: string, workspaceId: string) {
    const board = await this.getBoard(boardId, workspaceId);
    const updated = await this.kanbanRepo.updateBoard(board.id, {
      title: title.trim(),
    });
    this.auditService.log({
      event: AuditEvent.KANBAN_BOARD_UPDATED,
      resourceType: AuditResource.KANBAN_BOARD,
      resourceId: board.id,
      spaceId: board.spaceId,
      changes: {
        before: { title: board.title },
        after: { title: updated.title },
      },
    });
    this.emit(board.spaceId, board.id);
    return updated;
  }

  async deleteBoard(boardId: string, workspaceId: string) {
    const board = await this.getBoard(boardId, workspaceId);
    await this.kanbanRepo.deleteBoard(board.id);
    this.auditService.log({
      event: AuditEvent.KANBAN_BOARD_DELETED,
      resourceType: AuditResource.KANBAN_BOARD,
      resourceId: board.id,
      spaceId: board.spaceId,
      changes: { before: { title: board.title } },
    });
    this.emit(board.spaceId, board.id);
  }

  async createColumn(dto: CreateColumnDto, workspaceId: string) {
    const board = await this.getBoard(dto.boardId, workspaceId);
    if ((await this.kanbanRepo.countColumns(board.id)) >= MAX_COLUMNS) {
      throw new BadRequestException(
        `A board can have at most ${MAX_COLUMNS} columns`,
      );
    }
    const column = await this.kanbanRepo.insertColumn({
      boardId: board.id,
      name: dto.name.trim(),
      color: dto.color ?? null,
      position: dto.position,
    });
    this.auditService.log({
      event: AuditEvent.KANBAN_COLUMN_CREATED,
      resourceType: AuditResource.KANBAN_COLUMN,
      resourceId: column.id,
      spaceId: board.spaceId,
      metadata: { boardId: board.id },
      changes: { after: { name: column.name, color: column.color } },
    });
    this.emit(board.spaceId, board.id);
    return column;
  }

  async updateColumn(dto: UpdateColumnDto, workspaceId: string) {
    const board = await this.getBoard(dto.boardId, workspaceId);
    const column = await this.requireColumn(dto.columnId, board.id);
    const updated = await this.kanbanRepo.updateColumn(column.id, board.id, {
      ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
      ...(dto.color !== undefined ? { color: dto.color } : {}),
    });
    this.auditService.log({
      event: AuditEvent.KANBAN_COLUMN_UPDATED,
      resourceType: AuditResource.KANBAN_COLUMN,
      resourceId: column.id,
      spaceId: board.spaceId,
      metadata: { boardId: board.id },
      changes: {
        before: { name: column.name, color: column.color },
        after: { name: updated.name, color: updated.color },
      },
    });
    this.emit(board.spaceId, board.id);
    return updated;
  }

  async moveColumn(dto: MoveColumnDto, workspaceId: string) {
    const board = await this.getBoard(dto.boardId, workspaceId);
    const column = await this.requireColumn(dto.columnId, board.id);
    const updated = await this.kanbanRepo.updateColumn(column.id, board.id, {
      position: dto.position,
    });
    this.auditService.log({
      event: AuditEvent.KANBAN_COLUMN_MOVED,
      resourceType: AuditResource.KANBAN_COLUMN,
      resourceId: column.id,
      spaceId: board.spaceId,
      metadata: { boardId: board.id },
      changes: {
        before: { position: column.position },
        after: { position: updated.position },
      },
    });
    this.emit(board.spaceId, board.id);
    return updated;
  }

  async deleteColumn(
    dto: { boardId: string; columnId: string },
    workspaceId: string,
  ) {
    const board = await this.getBoard(dto.boardId, workspaceId);
    const column = await this.requireColumn(dto.columnId, board.id);
    if ((await this.kanbanRepo.countColumnCards(column.id)) > 0) {
      throw new BadRequestException(
        'Move or delete all cards before deleting this column',
      );
    }
    await this.kanbanRepo.deleteColumn(column.id, board.id);
    this.auditService.log({
      event: AuditEvent.KANBAN_COLUMN_DELETED,
      resourceType: AuditResource.KANBAN_COLUMN,
      resourceId: column.id,
      spaceId: board.spaceId,
      metadata: { boardId: board.id },
      changes: { before: { name: column.name, color: column.color } },
    });
    this.emit(board.spaceId, board.id);
  }

  async createCard(dto: CreateCardDto, user: User, workspaceId: string) {
    const board = await this.getBoard(dto.boardId, workspaceId);
    await this.requireColumn(dto.columnId, board.id);
    if ((await this.kanbanRepo.countCards(board.id)) >= MAX_CARDS) {
      throw new BadRequestException(
        `A board can have at most ${MAX_CARDS} cards`,
      );
    }
    await this.validateAssignee(dto.assigneeId, board.spaceId, workspaceId);
    const card = await this.kanbanRepo.insertCard({
      boardId: board.id,
      columnId: dto.columnId,
      title: dto.title.trim(),
      description: dto.description ?? null,
      position: dto.position,
      assigneeId: dto.assigneeId ?? null,
      priority: dto.priority ?? null,
      dueDate: dto.dueDate ?? null,
      labels: this.normalizeLabels(dto.labels),
      creatorId: user.id,
    });
    this.auditService.log({
      event: AuditEvent.KANBAN_CARD_CREATED,
      resourceType: AuditResource.KANBAN_CARD,
      resourceId: card.id,
      spaceId: board.spaceId,
      metadata: { boardId: board.id, columnId: card.columnId },
      changes: { after: this.cardAuditFields(card) },
    });
    this.emit(board.spaceId, board.id);
    return card;
  }

  async updateCard(dto: UpdateCardDto, workspaceId: string) {
    const board = await this.getBoard(dto.boardId, workspaceId);
    const card = await this.requireCard(dto.cardId, board.id);
    await this.validateAssignee(dto.assigneeId, board.spaceId, workspaceId);
    const updated = await this.kanbanRepo.updateCard(card.id, board.id, {
      ...(dto.title !== undefined ? { title: dto.title.trim() } : {}),
      ...(dto.description !== undefined
        ? { description: dto.description }
        : {}),
      ...(dto.assigneeId !== undefined ? { assigneeId: dto.assigneeId } : {}),
      ...(dto.priority !== undefined ? { priority: dto.priority } : {}),
      ...(dto.dueDate !== undefined ? { dueDate: dto.dueDate } : {}),
      ...(dto.labels !== undefined
        ? { labels: this.normalizeLabels(dto.labels) }
        : {}),
    });
    const assignmentChanged = card.assigneeId !== updated.assigneeId;
    this.auditService.log({
      event: AuditEvent.KANBAN_CARD_UPDATED,
      resourceType: AuditResource.KANBAN_CARD,
      resourceId: card.id,
      spaceId: board.spaceId,
      metadata: {
        boardId: board.id,
        descriptionChanged: dto.description !== undefined,
      },
      changes: {
        before: this.cardAuditFields(card),
        after: this.cardAuditFields(updated),
      },
    });
    if (assignmentChanged) {
      this.auditService.log({
        event: AuditEvent.KANBAN_CARD_ASSIGNED,
        resourceType: AuditResource.KANBAN_CARD,
        resourceId: card.id,
        spaceId: board.spaceId,
        metadata: { boardId: board.id },
        changes: {
          before: { assigneeId: card.assigneeId },
          after: { assigneeId: updated.assigneeId },
        },
      });
    }
    this.emit(board.spaceId, board.id);
    return updated;
  }

  async moveCard(dto: MoveCardDto, workspaceId: string) {
    const board = await this.getBoard(dto.boardId, workspaceId);
    const card = await this.requireCard(dto.cardId, board.id);
    await this.requireColumn(dto.columnId, board.id);
    const updated = await this.kanbanRepo.updateCard(card.id, board.id, {
      columnId: dto.columnId,
      position: dto.position,
    });
    this.auditService.log({
      event: AuditEvent.KANBAN_CARD_MOVED,
      resourceType: AuditResource.KANBAN_CARD,
      resourceId: card.id,
      spaceId: board.spaceId,
      metadata: { boardId: board.id },
      changes: {
        before: { columnId: card.columnId, position: card.position },
        after: { columnId: updated.columnId, position: updated.position },
      },
    });
    this.emit(board.spaceId, board.id);
    return updated;
  }

  async deleteCard(
    dto: { boardId: string; cardId: string },
    workspaceId: string,
  ) {
    const board = await this.getBoard(dto.boardId, workspaceId);
    const card = await this.requireCard(dto.cardId, board.id);
    await this.kanbanRepo.deleteCard(card.id, board.id);
    this.auditService.log({
      event: AuditEvent.KANBAN_CARD_DELETED,
      resourceType: AuditResource.KANBAN_CARD,
      resourceId: card.id,
      spaceId: board.spaceId,
      metadata: { boardId: board.id, columnId: card.columnId },
      changes: { before: this.cardAuditFields(card) },
    });
    this.emit(board.spaceId, board.id);
  }

  private async requireColumn(columnId: string, boardId: string) {
    const column = await this.kanbanRepo.findColumn(columnId, boardId);
    if (!column) throw new NotFoundException('Column not found');
    return column;
  }

  private async requireCard(cardId: string, boardId: string) {
    const card = await this.kanbanRepo.findCard(cardId, boardId);
    if (!card) throw new NotFoundException('Card not found');
    return card;
  }

  private async validateAssignee(
    assigneeId: string | null | undefined,
    spaceId: string,
    workspaceId: string,
  ) {
    if (assigneeId === undefined || assigneeId === null) return;
    const user = await this.userRepo.findById(assigneeId, workspaceId);
    const allowed = await this.spaceMemberRepo.getUserIdsWithSpaceAccess(
      [assigneeId],
      spaceId,
    );
    if (
      !user ||
      user.deletedAt ||
      user.deactivatedAt ||
      !allowed.has(assigneeId)
    ) {
      throw new BadRequestException('Assignee must be an active space member');
    }
  }

  private normalizeLabels(labels?: string[]): string[] {
    if (!labels) return [];
    const normalized = [
      ...new Set(labels.map((label) => label.trim()).filter(Boolean)),
    ];
    if (
      normalized.length > 10 ||
      normalized.some((label) => label.length > 30)
    ) {
      throw new BadRequestException(
        'Cards support at most 10 labels of 30 characters',
      );
    }
    return normalized;
  }

  private cardAuditFields(card: {
    title: string;
    columnId: string;
    assigneeId: string | null;
    priority: string | null;
    dueDate: unknown;
    labels: unknown;
  }) {
    return {
      title: card.title,
      columnId: card.columnId,
      assigneeId: card.assigneeId,
      priority: card.priority,
      dueDate: card.dueDate,
      labels: card.labels,
    };
  }

  private emit(spaceId: string, boardId: string): void {
    this.wsService.emitToSpace(spaceId, {
      operation: 'invalidate',
      entity: ['kanban-board'],
      id: boardId,
    });
  }
}
