import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { dbOrTx } from '@docmost/db/utils';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import {
  InsertableKanbanBoard,
  InsertableKanbanCard,
  InsertableKanbanColumn,
  UpdatableKanbanBoard,
  UpdatableKanbanCard,
  UpdatableKanbanColumn,
} from '@docmost/db/types/entity.types';

@Injectable()
export class KanbanRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  findBoard(boardId: string, workspaceId: string, trx?: KyselyTransaction) {
    return dbOrTx(this.db, trx)
      .selectFrom('kanbanBoards')
      .selectAll()
      .where('id', '=', boardId)
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();
  }

  listBoards(spaceId: string, workspaceId: string) {
    return this.db
      .selectFrom('kanbanBoards')
      .selectAll()
      .where('spaceId', '=', spaceId)
      .where('workspaceId', '=', workspaceId)
      .orderBy('createdAt', 'desc')
      .execute();
  }

  listColumns(boardId: string, trx?: KyselyTransaction) {
    return dbOrTx(this.db, trx)
      .selectFrom('kanbanColumns')
      .selectAll()
      .where('boardId', '=', boardId)
      .orderBy('position', 'asc')
      .orderBy('id', 'asc')
      .execute();
  }

  listCards(boardId: string, trx?: KyselyTransaction) {
    return dbOrTx(this.db, trx)
      .selectFrom('kanbanCards')
      .leftJoin('users as assignee', 'assignee.id', 'kanbanCards.assigneeId')
      .selectAll('kanbanCards')
      .select([
        'assignee.name as assigneeName',
        'assignee.avatarUrl as assigneeAvatarUrl',
      ])
      .where('kanbanCards.boardId', '=', boardId)
      .orderBy('kanbanCards.columnId', 'asc')
      .orderBy('kanbanCards.position', 'asc')
      .orderBy('kanbanCards.id', 'asc')
      .execute();
  }

  findColumn(columnId: string, boardId: string, trx?: KyselyTransaction) {
    return dbOrTx(this.db, trx)
      .selectFrom('kanbanColumns')
      .selectAll()
      .where('id', '=', columnId)
      .where('boardId', '=', boardId)
      .executeTakeFirst();
  }

  findCard(cardId: string, boardId: string, trx?: KyselyTransaction) {
    return dbOrTx(this.db, trx)
      .selectFrom('kanbanCards')
      .selectAll()
      .where('id', '=', cardId)
      .where('boardId', '=', boardId)
      .executeTakeFirst();
  }

  async countColumns(boardId: string): Promise<number> {
    const result = await this.db
      .selectFrom('kanbanColumns')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('boardId', '=', boardId)
      .executeTakeFirstOrThrow();
    return Number(result.count);
  }

  async countCards(boardId: string): Promise<number> {
    const result = await this.db
      .selectFrom('kanbanCards')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('boardId', '=', boardId)
      .executeTakeFirstOrThrow();
    return Number(result.count);
  }

  async countColumnCards(columnId: string): Promise<number> {
    const result = await this.db
      .selectFrom('kanbanCards')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('columnId', '=', columnId)
      .executeTakeFirstOrThrow();
    return Number(result.count);
  }

  insertBoard(value: InsertableKanbanBoard, trx?: KyselyTransaction) {
    return dbOrTx(this.db, trx)
      .insertInto('kanbanBoards')
      .values(value)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  insertColumn(value: InsertableKanbanColumn, trx?: KyselyTransaction) {
    return dbOrTx(this.db, trx)
      .insertInto('kanbanColumns')
      .values(value)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  insertCard(value: InsertableKanbanCard, trx?: KyselyTransaction) {
    return dbOrTx(this.db, trx)
      .insertInto('kanbanCards')
      .values(value)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  updateBoard(boardId: string, value: UpdatableKanbanBoard) {
    return this.db
      .updateTable('kanbanBoards')
      .set({ ...value, updatedAt: new Date() })
      .where('id', '=', boardId)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  updateColumn(
    columnId: string,
    boardId: string,
    value: UpdatableKanbanColumn,
  ) {
    return this.db
      .updateTable('kanbanColumns')
      .set({ ...value, updatedAt: new Date() })
      .where('id', '=', columnId)
      .where('boardId', '=', boardId)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  updateCard(cardId: string, boardId: string, value: UpdatableKanbanCard) {
    return this.db
      .updateTable('kanbanCards')
      .set({ ...value, updatedAt: new Date() })
      .where('id', '=', cardId)
      .where('boardId', '=', boardId)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  deleteBoard(boardId: string) {
    return this.db
      .deleteFrom('kanbanBoards')
      .where('id', '=', boardId)
      .execute();
  }

  deleteColumn(columnId: string, boardId: string) {
    return this.db
      .deleteFrom('kanbanColumns')
      .where('id', '=', columnId)
      .where('boardId', '=', boardId)
      .execute();
  }

  deleteCard(cardId: string, boardId: string) {
    return this.db
      .deleteFrom('kanbanCards')
      .where('id', '=', cardId)
      .where('boardId', '=', boardId)
      .execute();
  }
}
