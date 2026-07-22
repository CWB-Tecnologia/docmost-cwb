import { BadRequestException, NotFoundException } from '@nestjs/common';
import { KanbanService } from './kanban.service';

describe('KanbanService invariants', () => {
  const board = {
    id: 'board-id',
    title: 'Support',
    spaceId: 'space-id',
    workspaceId: 'workspace-id',
  };
  let repo: Record<string, jest.Mock>;
  let service: KanbanService;

  beforeEach(() => {
    repo = {
      findBoard: jest.fn().mockResolvedValue(board),
      findColumn: jest.fn().mockResolvedValue({
        id: 'column-id',
        boardId: board.id,
        name: 'To do',
        color: null,
        position: 'a0',
      }),
      findCard: jest.fn().mockResolvedValue({
        id: 'card-id',
        boardId: board.id,
        columnId: 'column-id',
        title: 'Investigate',
        position: 'a0',
        assigneeId: null,
        priority: null,
        dueDate: null,
        labels: [],
      }),
      countCards: jest.fn().mockResolvedValue(0),
      countColumnCards: jest.fn().mockResolvedValue(0),
      insertCard: jest.fn(),
      updateCard: jest.fn(),
      deleteColumn: jest.fn(),
    };
    service = new KanbanService(
      null,
      repo as never,
      { getUserIdsWithSpaceAccess: jest.fn() } as never,
      { findById: jest.fn() } as never,
      { emitToSpace: jest.fn() } as never,
      { log: jest.fn() } as never,
    );
  });

  it('rejects deleting a non-empty column', async () => {
    repo.countColumnCards.mockResolvedValue(1);

    await expect(
      service.deleteColumn(
        { boardId: board.id, columnId: 'column-id' },
        board.workspaceId,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.deleteColumn).not.toHaveBeenCalled();
  });

  it('enforces the 500-card board limit', async () => {
    repo.countCards.mockResolvedValue(500);

    await expect(
      service.createCard(
        {
          boardId: board.id,
          columnId: 'column-id',
          title: 'One too many',
          position: 'a1',
        },
        { id: 'user-id' } as never,
        board.workspaceId,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.insertCard).not.toHaveBeenCalled();
  });

  it('rejects moving a card to a column outside the board', async () => {
    repo.findColumn.mockResolvedValue(undefined);

    await expect(
      service.moveCard(
        {
          boardId: board.id,
          cardId: 'card-id',
          columnId: 'foreign-column',
          position: 'a1',
        },
        board.workspaceId,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.updateCard).not.toHaveBeenCalled();
  });
});
